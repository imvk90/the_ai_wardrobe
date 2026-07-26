/* ═══════════════════════════════════════════════════════════════
   ARCHIVE // Secure Digital Wardrobe — Frontend Engine
   Connects to FastAPI backend at API_BASE
   ═══════════════════════════════════════════════════════════════ */

const API_BASE = 'https://the-ai-wardrobe.onrender.com';

// ─── State ───
let currentUser = null;   // { user_id, username }
let isLoginMode = true;
let wardrobeItems = [];
let activeCategory = 'All';
let tryonGarmentId = null;
let tryonPersonFile = null;

// ─── DOM Refs ───
const authOverlay      = document.getElementById('auth-overlay');
const authTitle        = document.getElementById('auth-title');
const authSubtitle     = document.getElementById('auth-subtitle');
const authError        = document.getElementById('auth-error');
const authUsername      = document.getElementById('auth-username');
const authPassword     = document.getElementById('auth-password');
const authSubmitBtn    = document.getElementById('auth-submit-btn');
const authToggleText   = document.getElementById('auth-toggle-text');
const userHeaderTitle  = document.getElementById('user-header-title');
const itemCount        = document.getElementById('item-count');
const closetGrid       = document.getElementById('closet-grid');
const fileUploader     = document.getElementById('file-uploader');
const loader           = document.getElementById('loader');
const loaderText       = loader.querySelector('.loader-text');
const stylingOutput    = document.getElementById('styling-output');
const outfitModal      = document.getElementById('outfit-modal');
const outfitGridContent = document.getElementById('outfit-grid-content');
const outfitDescription = document.getElementById('outfit-description');
const outfitName       = document.getElementById('outfit-name');
const outfitVibe       = document.getElementById('outfit-vibe');
const tryonModal       = document.getElementById('tryon-modal');
const tryonGarmentImg  = document.getElementById('tryon-garment-img');
const tryonGarmentName = document.getElementById('tryon-garment-name');
const tryonPersonInput = document.getElementById('tryon-person-input');
const tryonPersonPreview = document.getElementById('tryon-person-preview');
const tryonPlaceholder = document.getElementById('tryon-upload-placeholder');
const tryonSubmitBtn   = document.getElementById('tryon-submit-btn');
const tryonResultModal = document.getElementById('tryon-result-modal');
const tryonResultImg   = document.getElementById('tryon-result-img');
const tryonResultMsg   = document.getElementById('tryon-result-msg');
const toast            = document.getElementById('toast');

// ═══════════════════════════════════════════════════════════════
// AUTHENTICATION (calls FastAPI /api/login & /api/register)
// ═══════════════════════════════════════════════════════════════

function toggleAuthMode() {
    isLoginMode = !isLoginMode;
    authError.textContent = '';
    authUsername.value = '';
    authPassword.value = '';
    if (isLoginMode) {
        authTitle.textContent = 'System Entry';
        authSubtitle.textContent = 'Authenticate to access your wardrobe';
        authSubmitBtn.textContent = 'Login';
        authToggleText.innerHTML = 'New operator? <span>Create Account</span>';
    } else {
        authTitle.textContent = 'New Operator';
        authSubtitle.textContent = 'Register a new wardrobe identity';
        authSubmitBtn.textContent = 'Create Account';
        authToggleText.innerHTML = 'Already registered? <span>Login</span>';
    }
}

async function handleAuthSubmit() {
    const username = authUsername.value.trim();
    const password = authPassword.value.trim();
    authError.textContent = '';

    if (!username || !password) {
        authError.textContent = '⚠ All fields required';
        shakeElement(authSubmitBtn);
        return;
    }

    const endpoint = isLoginMode ? '/api/login' : '/api/register';
    authSubmitBtn.disabled = true;
    authSubmitBtn.textContent = isLoginMode ? 'Authenticating...' : 'Creating...';

    try {
        const res = await fetch(`${API_BASE}${endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });

        const data = await res.json();

        if (!res.ok) {
            authError.textContent = `⚠ ${data.detail || 'Something went wrong'}`;
            shakeElement(authSubmitBtn);
            return;
        }

        // Success — login
        showToast(data.message || 'Welcome!');
        loginAs(data.user_id, data.username);

    } catch (err) {
        authError.textContent = '⚠ Cannot reach server. Is the backend running?';
        shakeElement(authSubmitBtn);
        console.error('Auth error:', err);
    } finally {
        authSubmitBtn.disabled = false;
        authSubmitBtn.textContent = isLoginMode ? 'Login' : 'Create Account';
    }
}

function loginAs(userId, username) {
    currentUser = { user_id: userId, username };
    localStorage.setItem('archive_session', JSON.stringify(currentUser));
    authOverlay.classList.add('hidden');
    userHeaderTitle.textContent = `${capitalize(username)}'s Archive ✨`;
    loadWardrobe();
}

function logoutUser() {
    currentUser = null;
    localStorage.removeItem('archive_session');
    wardrobeItems = [];
    closetGrid.innerHTML = '';
    itemCount.textContent = '0 items indexed';
    userHeaderTitle.textContent = 'Archive ✨';
    stylingOutput.textContent = 'Upload items & let the engine curate your perfect outfit pairing...';
    authOverlay.classList.remove('hidden');
    authUsername.value = '';
    authPassword.value = '';
    authError.textContent = '';
    if (!isLoginMode) toggleAuthMode();
}

function checkSession() {
    try {
        const saved = JSON.parse(localStorage.getItem('archive_session'));
        if (saved && saved.user_id && saved.username) {
            loginAs(saved.user_id, saved.username);
            return;
        }
    } catch {}
    authOverlay.classList.remove('hidden');
}

// ═══════════════════════════════════════════════════════════════
// WARDROBE — Load from backend & Render
// ═══════════════════════════════════════════════════════════════

async function loadWardrobe() {
    if (!currentUser) return;
    try {
        const res = await fetch(`${API_BASE}/api/get-wardrobe/${currentUser.user_id}`);
        if (!res.ok) throw new Error('Failed to fetch wardrobe');
        wardrobeItems = await res.json();
        renderGrid();
    } catch (err) {
        console.error('Load wardrobe error:', err);
        showToast('Failed to load wardrobe', true);
    }
}

function renderGrid() {
    closetGrid.innerHTML = '';

    let filtered = wardrobeItems;
    if (activeCategory !== 'All') {
        filtered = wardrobeItems.filter(i => i.category === activeCategory);
    }

    itemCount.textContent = `${wardrobeItems.length} item${wardrobeItems.length !== 1 ? 's' : ''} indexed`;

    if (filtered.length === 0) {
        closetGrid.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">👗</div>
                <h3>${activeCategory === 'All' ? 'Your wardrobe is empty' : 'No ' + activeCategory + ' yet'}</h3>
                <p>${activeCategory === 'All' ? 'Tap "+ Add Object" to index your first garment' : 'Add items in this category to see them here'}</p>
            </div>
        `;
        return;
    }

    filtered.forEach(item => {
        const card = document.createElement('div');
        card.className = 'card';
        card.setAttribute('data-tilt', '');
        card.setAttribute('data-tilt-max', '8');
        card.setAttribute('data-tilt-speed', '400');
        card.setAttribute('data-tilt-glare', 'true');
        card.setAttribute('data-tilt-max-glare', '0.15');
        card.setAttribute('data-tilt-perspective', '1200');

        // Build the image URL — backend returns relative path like /uploads/filename
        const imgSrc = item.imageUrl.startsWith('http')
            ? item.imageUrl
            : `${API_BASE}${item.imageUrl}`;

        card.innerHTML = `
            <div class="img-container">
                <img src="${imgSrc}" alt="${escapeHtml(item.subcategory)}" loading="lazy" />
                <div class="badge">${escapeHtml(item.category)}</div>
                <button class="delete-btn" onclick="deleteItem('${item.id}', event)" title="Remove">✕</button>
            </div>
            <div class="info">
                <h3>${escapeHtml(item.brand || 'Unknown')}</h3>
                <p>${escapeHtml(item.subcategory || 'Item')}</p>
                <button class="try-on-btn" onclick="openTryonModal('${item.id}', '${imgSrc}', '${escapeHtml(item.brand)} ${escapeHtml(item.subcategory)}')">Virtual Try-On</button>
            </div>
        `;

        closetGrid.appendChild(card);
    });

    // Initialize VanillaTilt on new cards
    if (typeof VanillaTilt !== 'undefined') {
        VanillaTilt.init(document.querySelectorAll('.card[data-tilt]'), {
            max: 8, speed: 400, glare: true, 'max-glare': 0.15, perspective: 1200
        });
    }
}

function filterCategory(category, el) {
    activeCategory = category;
    document.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
    if (el) el.classList.add('active');
    renderGrid();
}

// ═══════════════════════════════════════════════════════════════
// FILE UPLOAD → Gemini AI Auto-Categorization
// ═══════════════════════════════════════════════════════════════

fileUploader.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file || !currentUser) return;
    fileUploader.value = '';

    // Show the holographic scanner loader
    loaderText.textContent = 'Analyzing Fabric...';
    loader.classList.add('active');

    try {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('user_id', currentUser.user_id);

        const res = await fetch(`${API_BASE}/api/parse-clothing`, {
            method: 'POST',
            body: formData
        });

        const data = await res.json();

        if (!res.ok) {
            throw new Error(data.detail || 'Upload failed');
        }

        loader.classList.remove('active');

        const tags = data.tags || {};
        showToast(`Indexed: ${tags.estimated_brand || 'Unknown'} ${tags.subcategory || 'Item'} → ${tags.category}`);

        // Reload wardrobe from backend
        await loadWardrobe();

    } catch (err) {
        loader.classList.remove('active');
        showToast(`Upload failed: ${err.message}`, true);
        console.error('Upload error:', err);
    }
});

// ═══════════════════════════════════════════════════════════════
// DELETE ITEM
// ═══════════════════════════════════════════════════════════════

async function deleteItem(id, event) {
    event.stopPropagation();

    // Animate the card out
    const card = event.target.closest('.card');
    if (card) {
        card.style.transition = 'transform 0.4s, opacity 0.4s';
        card.style.transform = 'scale(0.85) translateY(20px)';
        card.style.opacity = '0';
    }

    try {
        const res = await fetch(`${API_BASE}/api/delete-item/${id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error('Delete failed');
        showToast('Item removed from archive');
        await loadWardrobe();
    } catch (err) {
        showToast('Failed to delete item', true);
        console.error('Delete error:', err);
        if (card) {
            card.style.transform = '';
            card.style.opacity = '';
        }
    }
}

// ═══════════════════════════════════════════════════════════════
// AI STYLIST — Gemini-Powered Outfit Recommendation
// ═══════════════════════════════════════════════════════════════

async function getAIRecommendation() {
    if (!currentUser) return;

    if (wardrobeItems.length < 2) {
        showToast('Add at least 2 items for AI pairing', true);
        stylingOutput.textContent = '⚠ Insufficient data. Index more garments for the engine to analyze.';
        return;
    }

    stylingOutput.textContent = '✨ Generating outfit — Gemini is analyzing your wardrobe...';

    try {
        const res = await fetch(`${API_BASE}/api/recommend/${currentUser.user_id}`);
        const data = await res.json();

        if (!res.ok) {
            throw new Error(data.detail || 'Recommendation failed');
        }

        // Populate the outfit modal
        outfitName.textContent = data.outfit_name || 'Curated Fit';
        outfitVibe.textContent = data.vibe || '';
        outfitDescription.textContent = data.description || '';

        outfitGridContent.innerHTML = '';
        (data.items || []).forEach(item => {
            const imgSrc = item.imageUrl.startsWith('http')
                ? item.imageUrl
                : `${API_BASE}${item.imageUrl}`;

            const div = document.createElement('div');
            div.className = 'outfit-item';
            div.innerHTML = `
                <img src="${imgSrc}" alt="${escapeHtml(item.subcategory)}" />
                <p>${escapeHtml(item.brand)} ${escapeHtml(item.subcategory)}</p>
            `;
            outfitGridContent.appendChild(div);
        });

        stylingOutput.textContent = `✨ "${data.outfit_name}" — ${data.vibe}. Tap "Pair Objects" to re-roll.`;
        outfitModal.classList.add('active');

    } catch (err) {
        stylingOutput.textContent = `⚠ ${err.message}`;
        showToast(err.message, true);
        console.error('Recommend error:', err);
    }
}

function closeOutfitModal() {
    outfitModal.classList.remove('active');
}

function rerollOutfit() {
    closeOutfitModal();
    setTimeout(() => getAIRecommendation(), 250);
}

// ═══════════════════════════════════════════════════════════════
// VIRTUAL TRY-ON
// ═══════════════════════════════════════════════════════════════

function openTryonModal(garmentId, garmentImgSrc, garmentLabel) {
    tryonGarmentId = garmentId;
    tryonPersonFile = null;
    tryonGarmentImg.src = garmentImgSrc;
    tryonGarmentName.textContent = garmentLabel;
    tryonPersonPreview.style.display = 'none';
    tryonPlaceholder.style.display = '';
    tryonSubmitBtn.disabled = true;
    tryonPersonInput.value = '';
    tryonModal.classList.add('active');
}

function closeTryonModal() {
    tryonModal.classList.remove('active');
    tryonGarmentId = null;
    tryonPersonFile = null;
}

// When user selects their photo for try-on
tryonPersonInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    tryonPersonFile = file;

    const reader = new FileReader();
    reader.onload = (ev) => {
        tryonPersonPreview.src = ev.target.result;
        tryonPersonPreview.style.display = 'block';
        tryonPlaceholder.style.display = 'none';
        tryonSubmitBtn.disabled = false;
    };
    reader.readAsDataURL(file);
});

async function submitTryon() {
    if (!tryonGarmentId || !tryonPersonFile) return;

    closeTryonModal();

    // Show loader with try-on text
    loaderText.textContent = 'Generating Try-On...';
    loader.classList.add('active');

    try {
        const formData = new FormData();
        formData.append('person_image', tryonPersonFile);
        formData.append('garment_id', tryonGarmentId);

        const res = await fetch(`${API_BASE}/api/virtual-try-on`, {
            method: 'POST',
            body: formData
        });

        const data = await res.json();
        loader.classList.remove('active');

        if (!res.ok) {
            throw new Error(data.detail || 'Try-on failed');
        }

        // Show result
        const resultUrl = data.result_url.startsWith('http')
            ? data.result_url
            : `${API_BASE}${data.result_url}`;

        tryonResultImg.src = resultUrl;
        tryonResultMsg.textContent = data.message || '';
        tryonResultModal.classList.add('active');

        showToast(data.status === 'success' ? 'Try-On Complete! ✨' : data.message);

    } catch (err) {
        loader.classList.remove('active');
        showToast(`Try-on failed: ${err.message}`, true);
        console.error('VTON error:', err);
    }
}

function closeTryonResult() {
    tryonResultModal.classList.remove('active');
}

// ═══════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════

function showToast(message, isError = false) {
    toast.textContent = message;
    toast.className = 'toast' + (isError ? ' error' : '');
    requestAnimationFrame(() => {
        toast.classList.add('show');
    });
    clearTimeout(toast._timeout);
    toast._timeout = setTimeout(() => {
        toast.classList.remove('show');
    }, 3500);
}

function shakeElement(el) {
    el.style.animation = 'none';
    el.offsetHeight; // reflow
    el.style.animation = 'shakeAnim 0.4s ease';
    setTimeout(() => el.style.animation = '', 500);
}

// Inject shake keyframes
const shakeStyle = document.createElement('style');
shakeStyle.textContent = `
    @keyframes shakeAnim {
        0%, 100% { transform: translateX(0); }
        20% { transform: translateX(-8px); }
        40% { transform: translateX(8px); }
        60% { transform: translateX(-5px); }
        80% { transform: translateX(5px); }
    }
`;
document.head.appendChild(shakeStyle);

function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function capitalize(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
}

// ═══════════════════════════════════════════════════════════════
// 3D TILT ON LOGIN CARD
// ═══════════════════════════════════════════════════════════════

function initLoginTilt() {
    if (typeof VanillaTilt !== 'undefined') {
        VanillaTilt.init(document.getElementById('auth-card-tilt'), {
            max: 12, speed: 600, glare: true, 'max-glare': 0.2,
            perspective: 1000, gyroscope: true
        });
    }
}

// ═══════════════════════════════════════════════════════════════
// KEYBOARD & MODAL DISMISS
// ═══════════════════════════════════════════════════════════════

document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !authOverlay.classList.contains('hidden')) {
        handleAuthSubmit();
        return;
    }
    if (e.key === 'Escape') {
        if (tryonModal.classList.contains('active')) closeTryonModal();
        else if (tryonResultModal.classList.contains('active')) closeTryonResult();
        else if (outfitModal.classList.contains('active')) closeOutfitModal();
    }
});

// Close modals on overlay click
[tryonModal, tryonResultModal, outfitModal].forEach(modal => {
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            modal.classList.remove('active');
        }
    });
});

// ═══════════════════════════════════════════════════════════════
// BOOT
// ═══════════════════════════════════════════════════════════════

(function boot() {
    initLoginTilt();
    checkSession();
})();
