import json
import os
import random
import re
import shutil
import sqlite3
import time

from fastapi import FastAPI, UploadFile, File, HTTPException, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from google import genai
from pydantic import BaseModel

# Try importing gradio_client for virtual try-on (optional dependency)
try:
    from gradio_client import Client as GradioClient, handle_file
    VTON_AVAILABLE = True
except ImportError:
    VTON_AVAILABLE = False
    print("[INFO] gradio_client not installed — Virtual Try-On will run in demo mode.")

# ═══════════════════════════════════════════════════════════════
# APP SETUP
# ═══════════════════════════════════════════════════════════════

app = FastAPI(title="ARCHIVE API", version="2.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

UPLOAD_DIR = "uploads"
os.makedirs(UPLOAD_DIR, exist_ok=True)
app.mount("/uploads", StaticFiles(directory=UPLOAD_DIR), name="uploads")

# ═══════════════════════════════════════════════════════════════
# GEMINI AI CLIENT
# ═══════════════════════════════════════════════════════════════

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
gemini_client = genai.Client(api_key=GEMINI_API_KEY) if GEMINI_API_KEY else None

# ═══════════════════════════════════════════════════════════════
# DATABASE
# ═══════════════════════════════════════════════════════════════

DB_FILE = "archive.db"

def get_db():
    """Get a database connection with Row factory for dict-like access."""
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn

def init_db():
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL
        )
    ''')
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS wardrobe (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            brand TEXT DEFAULT 'Unknown',
            category TEXT NOT NULL,
            subcategory TEXT DEFAULT 'Item',
            image_filename TEXT NOT NULL,
            created_at REAL DEFAULT (strftime('%s','now')),
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    ''')
    conn.commit()
    conn.close()

init_db()

# ═══════════════════════════════════════════════════════════════
# MODELS
# ═══════════════════════════════════════════════════════════════

class AuthRequest(BaseModel):
    username: str
    password: str

# ═══════════════════════════════════════════════════════════════
# AUTH ENDPOINTS
# ═══════════════════════════════════════════════════════════════

@app.post("/api/register")
async def register(req: AuthRequest):
    if len(req.username.strip()) < 3:
        raise HTTPException(status_code=400, detail="Username must be at least 3 characters")
    if len(req.password) < 4:
        raise HTTPException(status_code=400, detail="Password must be at least 4 characters")
    try:
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO users (username, password) VALUES (?, ?)",
            (req.username.strip().lower(), req.password)
        )
        conn.commit()
        user_id = cursor.lastrowid
        conn.close()
        return {"message": "Account created", "user_id": user_id, "username": req.username.strip().lower()}
    except sqlite3.IntegrityError:
        raise HTTPException(status_code=400, detail="Username already exists")

@app.post("/api/login")
async def login(req: AuthRequest):
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute(
        "SELECT id, username FROM users WHERE username = ? AND password = ?",
        (req.username.strip().lower(), req.password)
    )
    user = cursor.fetchone()
    conn.close()
    if user:
        return {"message": "Login successful", "user_id": user["id"], "username": user["username"]}
    raise HTTPException(status_code=401, detail="Invalid credentials")

# ═══════════════════════════════════════════════════════════════
# WARDROBE ENDPOINTS
# ═══════════════════════════════════════════════════════════════

@app.post("/api/parse-clothing")
async def parse_clothing(file: UploadFile = File(...), user_id: int = Form(...)):
    """Upload a clothing image → Gemini AI auto-categorizes → saves to DB."""
    try:
        # Save file to disk
        ext = file.filename.split(".")[-1] if "." in file.filename else "jpg"
        unique_filename = f"user_{user_id}_{int(time.time())}.{ext}"
        file_path = os.path.join(UPLOAD_DIR, unique_filename)

        with open(file_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)

        if not gemini_client:
            raise HTTPException(status_code=400, detail="GEMINI_API_KEY environment variable is missing on Render. Please add GEMINI_API_KEY under Environment in Render dashboard.")

        # Read file for Gemini analysis
        with open(file_path, "rb") as f:
            image_bytes = f.read()

        prompt = """
        Analyze this clothing image. Return ONLY a raw JSON object with no markdown formatting:
        {"category": "...", "subcategory": "...", "estimated_brand": "..."}

        RULES:
        - "category" MUST be exactly one of: "Tops", "Bottoms", "Outerwear", "Shoes"
        - "subcategory" should be specific (e.g., "Hoodie", "Sneakers", "Denim Jacket", "Cargo Pants")
        - "estimated_brand" should be the brand if visible, otherwise "Unknown"
        - Return ONLY the JSON object, no backticks, no explanation
        """

        response = gemini_client.models.generate_content(
            model='gemini-2.5-flash',
            contents=[
                genai.types.Part.from_bytes(
                    data=image_bytes,
                    mime_type=file.content_type or "image/jpeg"
                ),
                prompt
            ]
        )

        raw = response.text.strip()
        match = re.search(r'\{.*\}', raw, re.DOTALL)
        tags = json.loads(match.group(0) if match else raw)

        # Validate category
        valid_categories = ["Tops", "Bottoms", "Outerwear", "Shoes"]
        if tags.get("category") not in valid_categories:
            tags["category"] = "Tops"

        # Save to database
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO wardrobe (user_id, brand, category, subcategory, image_filename) VALUES (?, ?, ?, ?, ?)",
            (
                user_id,
                tags.get("estimated_brand", "Unknown"),
                tags["category"],
                tags.get("subcategory", "Item"),
                unique_filename
            )
        )
        conn.commit()
        item_id = cursor.lastrowid
        conn.close()

        return {
            "status": "success",
            "id": str(item_id),
            "filename": unique_filename,
            "tags": tags
        }

    except Exception as e:
        print(f"[parse-clothing error]: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/get-wardrobe/{user_id}")
async def get_wardrobe(user_id: int):
    """Get all wardrobe items for a user, newest first."""
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute(
        "SELECT id, brand, category, subcategory, image_filename, created_at "
        "FROM wardrobe WHERE user_id = ? ORDER BY created_at DESC",
        (user_id,)
    )
    rows = cursor.fetchall()
    conn.close()

    return [
        {
            "id": str(row["id"]),
            "brand": row["brand"],
            "category": row["category"],
            "subcategory": row["subcategory"],
            "imageUrl": f"/uploads/{row['image_filename']}",
            "created_at": row["created_at"]
        }
        for row in rows
    ]


@app.delete("/api/delete-item/{item_id}")
async def delete_item(item_id: int):
    """Delete a wardrobe item and its image file."""
    conn = get_db()
    cursor = conn.cursor()

    cursor.execute("SELECT image_filename FROM wardrobe WHERE id = ?", (item_id,))
    row = cursor.fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Item not found")

    cursor.execute("DELETE FROM wardrobe WHERE id = ?", (item_id,))
    conn.commit()
    conn.close()

    # Remove image file from disk
    file_path = os.path.join(UPLOAD_DIR, row["image_filename"])
    if os.path.exists(file_path):
        os.remove(file_path)

    return {"status": "deleted", "id": item_id}

# ═══════════════════════════════════════════════════════════════
# AI OUTFIT RECOMMENDATION
# ═══════════════════════════════════════════════════════════════

@app.get("/api/recommend/{user_id}")
async def recommend_outfit(user_id: int):
    """Use Gemini to create a styled outfit from the user's wardrobe."""
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute(
        "SELECT id, brand, category, subcategory, image_filename FROM wardrobe WHERE user_id = ?",
        (user_id,)
    )
    rows = cursor.fetchall()
    conn.close()

    if len(rows) < 2:
        raise HTTPException(status_code=400, detail="Add at least 2 items for AI styling")

    # Build wardrobe description for Gemini
    items_desc = "\n".join(
        f"  ID:{row['id']} — {row['brand']} {row['subcategory']} ({row['category']})"
        for row in rows
    )

    prompt = f"""You are an expert GenZ fashion stylist. Here is a wardrobe inventory:
{items_desc}

Create ONE fire outfit from these items. Pick pieces that complement each other.
Return ONLY a JSON object (no markdown, no backticks):
{{
    "selected_ids": [list of selected item IDs as integers],
    "outfit_name": "A creative outfit name",
    "vibe": "2-3 word vibe",
    "description": "A short, hype GenZ-style description of why these go hard together (2-3 sentences)"
}}
"""

    try:
        response = gemini_client.models.generate_content(
            model='gemini-2.5-flash',
            contents=[prompt]
        )
        raw = response.text.strip()
        match = re.search(r'\{.*\}', raw, re.DOTALL)
        result = json.loads(match.group(0) if match else raw)

        # Map IDs to full item data
        items_map = {
            str(row["id"]): {
                "id": str(row["id"]),
                "brand": row["brand"],
                "category": row["category"],
                "subcategory": row["subcategory"],
                "imageUrl": f"/uploads/{row['image_filename']}"
            }
            for row in rows
        }

        selected = []
        for sid in result.get("selected_ids", []):
            item = items_map.get(str(sid))
            if item:
                selected.append(item)

        # Fallback if Gemini returned bad IDs
        if not selected:
            keys = random.sample(list(items_map.keys()), min(3, len(items_map)))
            selected = [items_map[k] for k in keys]

        return {
            "outfit_name": result.get("outfit_name", "Curated Fit"),
            "vibe": result.get("vibe", "effortless cool"),
            "description": result.get("description", "A perfectly curated outfit from your archive."),
            "items": selected
        }

    except Exception as e:
        print(f"[recommend error]: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# ═══════════════════════════════════════════════════════════════
# VIRTUAL TRY-ON — Multi-Space Fallback Chain
# ═══════════════════════════════════════════════════════════════

def _try_idm_vton(person_path, garment_path, category):
    """Space 1: yisol/IDM-VTON (most popular, often busy)."""
    print("  [1/3] Trying yisol/IDM-VTON...")
    hf = GradioClient("yisol/IDM-VTON")
    result = hf.predict(
        dict={"background": handle_file(person_path), "layers": [], "composite": None},
        garm_img=handle_file(garment_path),
        garment_des=f"A clean presentation of a {category}",
        is_checked=True,
        is_checked_crop=False,
        denoise_steps=30,
        seed=42,
        api_name="/tryon"
    )
    return result[0]

def _try_nymbo_vton(person_path, garment_path, category):
    """Space 2: Nymbo/Virtual-Try-On (lighter, often available)."""
    print("  [2/3] Trying Nymbo/Virtual-Try-On...")
    hf = GradioClient("Nymbo/Virtual-Try-On")
    result = hf.predict(
        dict={"background": handle_file(person_path), "layers": [], "composite": None},
        garm_img=handle_file(garment_path),
        garment_des=f"A {category} garment",
        is_checked=True,
        is_checked_crop=False,
        denoise_steps=30,
        seed=42,
        api_name="/tryon"
    )
    return result[0]

def _try_kolors_vton(person_path, garment_path, category):
    """Space 3: Kwai-Kolors/Kolors-Virtual-Try-On."""
    print("  [3/3] Trying Kwai-Kolors/Kolors-Virtual-Try-On...")
    hf = GradioClient("Kwai-Kolors/Kolors-Virtual-Try-On")
    result = hf.predict(
        person_img=handle_file(person_path),
        garment_img=handle_file(garment_path),
        seed=42,
        randomize_seed=False,
        api_name="/tryon"
    )
    # Kolors returns (image_path, seed) tuple
    return result[0] if isinstance(result, (list, tuple)) else result


# The ordered list of VTON spaces to try
VTON_SPACES = [
    ("yisol/IDM-VTON", _try_idm_vton),
    ("Nymbo/Virtual-Try-On", _try_nymbo_vton),
    ("Kwai-Kolors/Kolors-Virtual-Try-On", _try_kolors_vton),
]


@app.post("/api/virtual-try-on")
async def virtual_try_on(person_image: UploadFile = File(...), garment_id: str = Form(...)):
    """Virtual try-on with multi-space fallback. Tries up to 3 free HF spaces."""
    try:
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute("SELECT image_filename, category FROM wardrobe WHERE id = ?", (garment_id,))
        row = cursor.fetchone()
        conn.close()

        if not row:
            raise HTTPException(status_code=404, detail="Garment not found")

        garment_filename = row["image_filename"]
        category = row["category"]
        garment_path = os.path.join(UPLOAD_DIR, garment_filename)

        # Save uploaded person photo temporarily
        temp_filename = f"temp_person_{int(time.time())}.jpg"
        temp_path = os.path.join(UPLOAD_DIR, temp_filename)
        with open(temp_path, "wb") as buffer:
            shutil.copyfileobj(person_image.file, buffer)

        # Try each VTON space in order
        if VTON_AVAILABLE:
            print(f"→ Starting Virtual Try-On cascade ({len(VTON_SPACES)} spaces available)...")

            for space_name, try_fn in VTON_SPACES:
                try:
                    result_image_path = try_fn(temp_path, garment_path, category)

                    # Success! Save the result
                    result_filename = f"vton_result_{int(time.time())}.jpg"
                    result_path = os.path.join(UPLOAD_DIR, result_filename)
                    shutil.copyfile(result_image_path, result_path)

                    # Cleanup temp person photo
                    if os.path.exists(temp_path):
                        os.remove(temp_path)

                    print(f"  ✅ Success via {space_name}")
                    return {
                        "status": "success",
                        "result_url": f"/uploads/{result_filename}",
                        "message": f"AI Try-On Complete via {space_name}! ✨"
                    }

                except Exception as space_err:
                    print(f"  ❌ {space_name} failed: {space_err}")
                    continue  # Try the next space

            print("  ⚠ All VTON spaces failed — entering demo mode.")

        # Cleanup temp file
        if os.path.exists(temp_path):
            os.remove(temp_path)

        # Fallback: demo mode (all spaces failed or gradio_client not installed)
        return {
            "status": "demo",
            "result_url": f"/uploads/{garment_filename}",
            "message": f"All free GPU queues are busy right now. Showing {category} preview instead."
        }

    except HTTPException:
        raise
    except Exception as e:
        print(f"[VTON error]: {e}")
        # Cleanup on crash
        temp_path_check = os.path.join(UPLOAD_DIR, f"temp_person_{int(time.time())}.jpg")
        if os.path.exists(temp_path_check):
            os.remove(temp_path_check)
        raise HTTPException(status_code=500, detail=str(e))

# ═══════════════════════════════════════════════════════════════
# SERVE FRONTEND
# ═══════════════════════════════════════════════════════════════

@app.get("/")
async def serve_index():
    return FileResponse("index.html")

@app.get("/app.js")
async def serve_js():
    return FileResponse("app.js")
