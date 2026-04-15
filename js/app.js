import { translations, destinationsList, trips } from './data.js';

// ─── Firebase Integration ──────────────────────────────────────────────────
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.11.0/firebase-app.js";
import { getDatabase, ref, set, onValue, push, update, increment } from "https://www.gstatic.com/firebasejs/10.11.0/firebase-database.js";
import { getAnalytics } from "https://www.gstatic.com/firebasejs/10.11.0/firebase-analytics.js";

const firebaseConfig = {
  apiKey: "AIzaSyAPq2j3HoksgtSFA3pfffjxoT4HI7gvyAk",
  authDomain: "taxi-tawat-1fa4d.firebaseapp.com",
  databaseURL: "https://taxi-tawat-1fa4d-default-rtdb.firebaseio.com",
  projectId: "taxi-tawat-1fa4d",
  storageBucket: "taxi-tawat-1fa4d.firebasestorage.app",
  messagingSenderId: "892501146606",
  appId: "1:892501146606:web:a6bd974f3e1a40b8896cff",
  measurementId: "G-QMVMNSCX1M"
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);
const analytics = getAnalytics(app);

// Global live state for real-time sync
let fbData = {
    drivers: {},
    bookings: {}
};

// ─── Global Language (FORCE ARABIC - MISSION Requirement) ───────────────────
window.currentLang = 'ar';
document.documentElement.lang = 'ar';
document.documentElement.dir = 'rtl';
localStorage.setItem('tawat_lang', 'ar');

// (The storage event sync is replaced by Firebase listeners)

// ─── Boot ──────────────────────────────────────────────────────────────────────
(function () {
    'use strict';

    // ── Translation (LOCKED TO ARABIC) ──────────────────────────────────────
    function t(key) {
        const lang = 'ar';
        return (translations && translations[lang] && translations[lang][key]) || key;
    }

    function setLang(lang) { // eslint-disable-line no-unused-vars
        window.currentLang = 'ar';
        localStorage.setItem('tawat_lang', 'ar');
        document.documentElement.lang = 'ar';
        document.documentElement.dir = 'rtl';
    }

    // ── State ────────────────────────────────────────────────────────────────
    const S = {
        userRole: () => localStorage.getItem('userRole'),
        passengerName: () => localStorage.getItem('passengerName') || '',
        passengerPhone: () => localStorage.getItem('passengerPhone') || '',
        driverName: () => localStorage.getItem('driverName') || '',
        driverPhone: () => localStorage.getItem('driverPhone') || '',
        driverLicense: () => localStorage.getItem('driverLicense') || '',
        driverColor: () => localStorage.getItem('driverColor') || '',
        driverDestId: () => localStorage.getItem('driverDestId') || '',
        schedule: function (dLic) {
            // Priority: Firebase -> LocalStorage -> Default
            const fbD = fbData.drivers[dLic];
            if (fbD && fbD.schedule) return fbD.schedule;

            const key = dLic ? ('tawat_sched_' + dLic) : 'tawat_schedule';
            try {
                const s = JSON.parse(localStorage.getItem(key));
                if (Array.isArray(s) && s.length === 7) {
                    return s.map(item => ({ ...item, direction: item.direction || 'to_dest' }));
                }
            } catch (e) { }
            
            const def = [];
            for (let i = 0; i < 7; i++) def.push({ status: 'available', seats: 8, time: '08:00', direction: 'to_dest' });
            return def;
        },
        specialDates: function (dLic) {
             const fbD = fbData.drivers[dLic || S.driverLicense()];
             if (fbD && fbD.specialDates) return fbD.specialDates;

            try {
                const all = JSON.parse(localStorage.getItem('tawat_special')) || [];
                const todayStr = new Date().toISOString().split('T')[0];
                return all.filter(d => d.date >= todayStr).map(item => ({ ...item, direction: item.direction || 'to_dest' }));
            } catch (e) { return []; }
        },
        bookings: function () {
            return Object.values(fbData.bookings || {});
        },
        // Anti-Conflict Checker Bridge
        isAvailable: function (dLic, dateIdx) {
            const sched = this.schedule(dLic);
            const eff = sched[dateIdx];
            return eff && eff.status !== 'full' && eff.seats > 0 && eff.status !== 'off';
        }
    };

    function saveSchedule(dLic, sched) {
        if (dLic) {
            update(ref(db, `drivers/${dLic.replace(/\./g, '_')}`), { schedule: sched });
        }
        const key = dLic ? ('tawat_sched_' + dLic) : 'tawat_schedule';
        localStorage.setItem(key, JSON.stringify(sched));
    }
    function saveSpecialDates(sd) {
        const dLic = S.driverLicense();
        if (dLic) {
            update(ref(db, `drivers/${dLic.replace(/\./g, '_')}`), { specialDates: sd });
        }
        localStorage.setItem('tawat_special', JSON.stringify(sd)); 
    }
    function saveBookings(bks) { 
        // Note: New flow uses push() for individual bookings, this is legacy compat
        // We'll update the booking creation parts to use push(ref(db, 'bookings'), ...)
    }

    // ── Firebase Sync ────────────────────────────────────────────────────────
    function initFirebaseSync() {
        onValue(ref(db, 'drivers'), (snap) => {
            fbData.drivers = {};
            snap.forEach(child => {
                fbData.drivers[child.key.replace(/_/g, '.')] = child.val();
            });
            render();
        });

        onValue(ref(db, 'bookings'), (snap) => {
            const oldBks = fbData.bookings || {};
            fbData.bookings = snap.val() || {};
            
            // Notification Logic (if a new pending booking appears for us)
            if (S.userRole() === 'driver') {
                const dLic = S.driverLicense();
                Object.keys(fbData.bookings).forEach(id => {
                    const b = fbData.bookings[id];
                    if (!oldBks[id] && b.status === 'pending' && b.driverLicense === dLic) {
                        showTopNotification(b);
                    }
                });
            }
            render();
        });
    }

    // Start Sync
    initFirebaseSync();

    // ── View State ───────────────────────────────────────────────────────────
    let view = 'onboarding';
    let selDestId = null;
    let selDateIdx = 0;
    let driverActiveTab = 'weekly';
    let driverSearchQuery = '';

    // ── Helpers ──────────────────────────────────────────────────────────────
    function fmt12(t24) {
        if (!t24) return '';
        const [h, m] = t24.split(':');
        const hr = parseInt(h, 10);
        return `${((hr + 11) % 12 + 1)}:${m} ${hr >= 12 ? 'PM' : 'AM'}`;
    }

    function week() {
        const days = [], now = new Date();
        for (let i = 0; i < 7; i++) {
            const d = new Date(now);
            d.setDate(now.getDate() + i);
            const key = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
            days.push({ num: d.getDate(), key: 'day' + key, iso: d.toISOString().split('T')[0] });
        }
        return days;
    }

    function dest(id) { return (destinationsList || []).find(d => d.id === id); }
    function destName(id) { const d = dest(id); return d ? (d.name[window.currentLang] || d.name.en) : id; }

    // ── Validation ───────────────────────────────────────────────────────────
    // Algerian phone: 10 digits, starts with 05, 06, or 07
    function validatePhone(p) { return /^0[567]\d{8}$/.test(p.replace(/\s/g, '')); }
    function validateName(n) { return n.length >= 2 && !/\d/.test(n); }
    function validateLicense(l) { return /^\d{2}-\d{3}-\d{5}$/.test(l); }

    function showError(id, msg) {
        const inp = document.getElementById(id);
        if (!inp) return;
        inp.style.borderColor = 'var(--danger)';
        let err = inp.parentNode.querySelector('.field-error-' + id);
        if (!err) {
            err = document.createElement('span');
            err.className = 'error-text field-error-' + id;
            inp.parentNode.insertBefore(err, inp.nextSibling);
        }
        err.textContent = msg;
    }
    function clearError(id) {
        const inp = document.getElementById(id);
        if (!inp) return;
        inp.style.borderColor = '';
        const err = inp.parentNode.querySelector('.field-error-' + id);
        if (err) err.remove();
    }

    // ── DOM Scaffolding ──────────────────────────────────────────────────────
    function el(tag, cls, html) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (html !== undefined) e.innerHTML = html;
        return e;
    }

    // ── Main Render ──────────────────────────────────────────────────────────
    const mc = document.getElementById('mainContent');
    const langSel = document.getElementById('langSwitcher');
    const profBtn = document.getElementById('profileBtn');
    const logoSpan = document.querySelector('.app-title');

    function updateHeader() {
        if (logoSpan) logoSpan.textContent = t('appTitle');

        // Sync lang switcher
        if (langSel) langSel.value = window.currentLang;

        // Profile button visibility
        if (profBtn) profBtn.style.display = ['home', 'trips', 'profile'].includes(view) ? 'flex' : 'none';

        if (window.lucide) lucide.createIcons();
    }

    function render() {
        if (!mc) { console.error('mainContent missing'); return; }
        mc.innerHTML = '';
        updateHeader();

        switch (view) {
            case 'onboarding': renderOnboarding(); break;
            case 'login': renderLogin(); break;
            case 'driverReg': renderDriverReg(); break;
            case 'home': renderHome(); break;
            case 'trips': renderTrips(); break;
            case 'driver': renderDriverDash(); break;
            case 'profile': renderProfile(); break;
            default: renderOnboarding();
        }

        if (window.lucide) lucide.createIcons();
    }

    // ── Cinematic Splash Controller V4 (Professional 'Telegram' Style) ───────
    function runSplash(callback) {
        const splash = document.getElementById('splashScreen');
        if (!splash) { callback(); return; }

        // Start Animation State
        setTimeout(() => {
            splash.classList.add('active');
        }, 100);

        // Transition to App after V2 Cinematic sequence (2.8s)
        setTimeout(() => {
            splash.classList.add('fade-out');
            document.body.classList.remove('content-loading');
            setTimeout(() => {
                splash.style.display = 'none';
                callback();
            }, 600);
        }, 2800);
    }

    // ── Sync Listener ────────────────────────────────────────────────────────
    window.addEventListener('tawatSync', (e) => {
        render(); // Instant re-render on data change from another tab

        // Notification Bridge: If we are a driver and a new booking happened
        if (S.userRole() === 'driver' && e.detail.key === 'tawat_bookings') {
            const allB = S.bookings();
            const newB = allB[allB.length - 1]; // Assume latest
            if (newB && newB.status === 'pending' && newB.driverLicense === S.driverLicense()) {
                showTopNotification(newB);
            }
        }
    });

    function showTopNotification(req) {
        const toast = el('div', 'toast-notification animate-in');
        toast.style.cssText = 'position:fixed;top:20px;left:20px;right:20px;background:rgba(30,41,59,0.9);backdrop-filter:blur(20px);color:#fff;padding:20px;border-radius:20px;display:flex;align-items:center;gap:16px;z-index:999999;box-shadow:0 15px 35px rgba(0,0,0,0.4);border:1px solid rgba(255,255,255,0.1);';
        toast.innerHTML = `
            <div style="width:50px;height:50px;background:#38bdf8;color:#fff;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:1.4rem;font-weight:800;box-shadow:0 0 15px rgba(56,189,248,0.5); flex-shrink:0;">${req.passengerName ? req.passengerName.charAt(0).toUpperCase() : '?'}</div>
            <div style="flex:1;">
                <div style="font-weight:800;font-size:1.1rem;margin-bottom:2px;color:#fff;">${t('newNotification')}</div>
                <div style="font-size:0.9rem;opacity:0.9;color:#e2e8f0;">${t('passengerInfo')}: ${req.passengerName}</div>
            </div>
            <button style="background:#38bdf8;border:none;color:#fff;padding:12px 20px;border-radius:14px;font-weight:800;cursor:pointer;white-space:nowrap;box-shadow:0 10px 20px rgba(56,189,248,0.25);" id="toastViewBtn">${t('accept')}</button>
        `;
        document.body.appendChild(toast);
        if (window.lucide) lucide.createIcons();

        toast.querySelector('#toastViewBtn').onclick = () => {
            toast.remove();
            driverActiveTab = 'weekly';
            render();
            const pends = S.bookings().filter(b => b.driverLicense === S.driverLicense() && b.status === 'pending');
            openDriverNotificationsDialog(pends, S.schedule(S.driverLicense()), S.driverLicense());
        };

        setTimeout(() => { if (toast.parentNode) toast.remove(); }, 8000);
    }

    // ── Views ────────────────────────────────────────────────────────────────

    function renderOnboarding() {
        const wrap = el('div', 'login-container animate-in');
        wrap.style.marginTop = '8vh';
        wrap.innerHTML = `
            <div style="text-align:center;margin-bottom:40px;">
                <h1 style="font-size:2.4rem;font-weight:800;letter-spacing:-1px;margin-bottom:8px;">TAXI TAWAT</h1>
                <p style="color:var(--text-muted);font-size:1.1rem;font-weight:500;">${t('chooseRole')}</p>
            </div>
            <div style="display:flex;flex-direction:column;gap:18px;">
                <button id="btnDriver" class="glass-card" style="flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:36px 24px;cursor:pointer;transition:all .3s;border:1px solid rgba(255,255,255,0.08);">
                    <div style="background:rgba(255,255,255,.08);border-radius:50%;width:68px;height:68px;display:flex;align-items:center;justify-content:center;transition:var(--transition);"><i data-lucide="car-front" style="width:30px;height:30px;color:#e2e8f0;"></i></div>
                    <span style="font-size:1.3rem;font-weight:800;color:#FFFFFF;">${t('iAmDriver')}</span>
                </button>
                <button id="btnTraveler" class="glass-card" style="flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:36px 24px;cursor:pointer;transition:all .3s;border:1px solid rgba(255,255,255,0.08);">
                    <div style="background:rgba(255,255,255,.08);border-radius:50%;width:68px;height:68px;display:flex;align-items:center;justify-content:center;transition:var(--transition);"><i data-lucide="luggage" style="width:30px;height:30px;color:#e2e8f0;"></i></div>
                    <span style="font-size:1.3rem;font-weight:800;color:#FFFFFF;">${t('iAmTraveler')}</span>
                </button>
            </div>`;
        mc.appendChild(wrap);

        document.getElementById('btnDriver').onclick = () => {
            localStorage.setItem('userRole', 'driver');
            const dn = S.driverName(), dl = S.driverLicense(), dd = S.driverDestId();
            view = (dn && dl && dd) ? 'driver' : 'driverReg';
            render();
        };
        document.getElementById('btnTraveler').onclick = () => {
            localStorage.setItem('userRole', 'passenger');
            view = S.passengerName() ? 'home' : 'login';
            render();
        };
    }

    function renderLogin() {
        const wrap = el('div', 'login-container animate-in');
        wrap.innerHTML = `
            <div class="view-header animate-in" style="margin-bottom: 16px;">
                <button class="back-btn" id="btnLoginBack"><i data-lucide="arrow-left"></i> ${t('back')}</button>
            </div>
            <h1 class="view-title" style="color:#FFFFFF;text-align:center;margin-bottom:24px;">${t('passengerLoginHeading')}</h1>
            <div class="glass-card" style="flex-direction:column;gap:14px;padding:24px;width:100%;">
                <div style="display:flex;flex-direction:column;gap:6px;width:100%;">
                    <label style="color:#FFFFFF;font-weight:600;font-size:0.95rem;">${t('enterFullName')}</label>
                    <input id="inName" class="glass-input" type="text" placeholder="${t('enterFullName')}" style="padding:14px;" />
                </div>
                <div style="display:flex;flex-direction:column;gap:6px;width:100%;">
                    <label style="color:#FFFFFF;font-weight:600;font-size:0.95rem;">${t('phone')}</label>
                    <input id="inPhone" class="glass-input" type="tel" placeholder="0X-XX-XX-XX-XX" maxlength="10" style="padding:14px;" />
                </div>
                <button id="btnStart" class="call-btn" style="margin-top:8px;">${t('startNavigating')}</button>
            </div>`;
        mc.appendChild(wrap);

        const nameInp = document.getElementById('inName');
        const phoneInp = document.getElementById('inPhone');

        // Live clear errors on typing
        nameInp.oninput = () => clearError('inName');
        phoneInp.oninput = () => { clearError('inPhone'); phoneInp.value = phoneInp.value.replace(/\D/g, '').slice(0, 10); };

        document.getElementById('btnLoginBack').onclick = () => { view = 'onboarding'; render(); };

        document.getElementById('btnStart').onclick = () => {
            const n = nameInp.value.trim();
            const p = phoneInp.value.trim();
            let valid = true;

            if (!validateName(n)) {
                showError('inName', t('errorName')); valid = false;
            }
            if (!validatePhone(p)) {
                showError('inPhone', t('errorPhone')); valid = false;
            }
            if (!valid) return;

            localStorage.setItem('passengerName', n);
            localStorage.setItem('passengerPhone', p);
            view = 'home'; render();
        };
    }

    function renderDriverReg() {
        const wrap = el('div', 'login-container animate-in');
        wrap.innerHTML = `
            <div class="view-header animate-in" style="margin-bottom: 16px;">
                <button class="back-btn" id="btnDriverRegBack"><i data-lucide="arrow-left"></i> ${t('back')}</button>
            </div>
            <h1 class="view-title" style="color:#FFFFFF;text-align:center;margin-bottom:24px;">${t('driverRegistrationHeading')}</h1>
            <div class="glass-card" style="flex-direction:column;gap:14px;padding:24px;width:100%;">
                <div style="display:flex;flex-direction:column;gap:6px;width:100%;">
                    <label style="color:#FFFFFF;font-weight:600;font-size:0.95rem;">${t('enterFullName')}</label>
                    <input id="drName" class="glass-input" type="text" placeholder="${t('enterFullName')}" style="padding:14px;" />
                </div>
                <div style="display:flex;flex-direction:column;gap:6px;width:100%;">
                    <label style="color:#FFFFFF;font-weight:600;font-size:0.95rem;">${t('phone')}</label>
                    <input id="drPhone" class="glass-input" type="tel" placeholder="0X-XX-XX-XX-XX" maxlength="10" style="padding:14px;" />
                </div>
                <div style="display:flex;flex-direction:column;gap:6px;width:100%;">
                    <label style="color:#FFFFFF;font-weight:600;font-size:0.95rem;">${t('licensePlate')}</label>
                    <input id="drLicense" class="glass-input" type="text" placeholder="${t('enterLicensePlate')}" maxlength="12" style="padding:14px;" />
                </div>
                <div style="display:flex;flex-direction:column;gap:6px;width:100%;">
                    <label style="color:#FFFFFF;font-weight:600;font-size:0.95rem;">${t('carColor')}</label>
                    <input id="drColor" class="glass-input" type="text" placeholder="${t('enterCarColor')}" style="padding:14px;" />
                </div>
                <div style="display:flex;flex-direction:column;gap:6px;width:100%;">
                    <label style="color:#FFFFFF;font-weight:600;font-size:0.95rem;">${t('route')}</label>
                    <select id="drDest" class="glass-input" style="padding:14px; width:100%; cursor:pointer;">
                        <option value="" disabled selected style="color:var(--text-muted);">${t('chooseYourRoute')}</option>
                        ${(destinationsList || []).map(d => `<option style="background:var(--bg-color);color:var(--text-main);" value="${d.id}">${d.id} - ${d.name[window.currentLang] || d.name.en}</option>`).join('')}
                    </select>
                </div>
                <button id="drSave" class="call-btn" style="margin-top:8px;">${t('registerNow')}</button>
            </div>`;
        mc.appendChild(wrap);

        const nameInp = document.getElementById('drName');
        const phoneInp = document.getElementById('drPhone');
        const licenseInp = document.getElementById('drLicense');

        nameInp.oninput = () => clearError('drName');
        phoneInp.oninput = () => { clearError('drPhone'); phoneInp.value = phoneInp.value.replace(/\D/g, '').slice(0, 10); };
        licenseInp.oninput = (e) => {
            clearError('drLicense');
            let v = e.target.value.replace(/\D/g, '').slice(0, 10);
            if (v.length > 5) v = v.slice(0, 2) + '-' + v.slice(2, 5) + '-' + v.slice(5);
            else if (v.length > 2) v = v.slice(0, 2) + '-' + v.slice(2);
            e.target.value = v;
        };

        document.getElementById('btnDriverRegBack').onclick = () => { view = 'onboarding'; render(); };

        document.getElementById('drSave').onclick = () => {
            const name = nameInp.value.trim();
            const phone = phoneInp.value.trim();
            const license = licenseInp.value.trim();
            const color = document.getElementById('drColor').value.trim();
            const destId = document.getElementById('drDest').value;
            let valid = true;

            if (!validateName(name)) {
                showError('drName', t('errorName')); valid = false;
            }
            if (!validatePhone(phone)) {
                showError('drPhone', t('errorPhone')); valid = false;
            }
            if (!validateLicense(license)) {
                showError('drLicense', t('errorLicense')); valid = false;
            }
            if (!destId) { valid = false; } // route select already shows placeholder
            if (!valid) return;

            localStorage.setItem('driverName', name);
            localStorage.setItem('driverPhone', phone);
            localStorage.setItem('driverLicense', license);
            localStorage.setItem('driverColor', color);
            localStorage.setItem('driverDestId', destId);

            // Sync Profile to Firebase
            const dLicKey = license.replace(/\./g, '_');
            update(ref(db, `drivers/${dLicKey}`), {
                profile: { name, phone, license, color, destId },
                lastSeen: Date.now()
            });

            view = 'driver'; render();
        };
    }

    function renderHome() {
        const hdr = el('div', 'view-header animate-in');
        hdr.style.justifyContent = 'space-between';
        hdr.innerHTML = `
        <h2 class="view-title">${t('destinations')}</h2>
        <button class="back-btn" id="btnHomeBack" style="font-size: 0.9rem;"><i data-lucide="arrow-left"></i> ${t('back')}</button>
    `;
        mc.appendChild(hdr);
        document.getElementById('btnHomeBack').onclick = () => { view = 'onboarding'; render(); };

        const list = el('div', 'card-list');
        (destinationsList || []).forEach((d, i) => {
            const card = el('div', 'glass-card animate-in');
            card.style.animationDelay = `${i * 0.05}s`;
            card.innerHTML = `
                <div class="route-info">
                    <div class="route-icon"><i data-lucide="${d.icon || 'map-pin'}"></i></div>
                    <div class="route-name">${d.name[window.currentLang] || d.name.en}</div>
                </div>
                <i data-lucide="chevron-right"></i>`;
            card.onclick = () => { selDestId = d.id; view = 'trips'; render(); };
            list.appendChild(card);
        });
        mc.appendChild(list);
    }

    function renderTrips() {
        const d = dest(selDestId);

        // ── Header ──
        const hdr = el('div', 'view-header animate-in',
            `<button class="back-btn" id="btnBack"><i data-lucide="arrow-left"></i> ${t('back')}</button>
             <h1 class="view-title">${d ? d.name[window.currentLang] || d.name.en : ''}</h1>`);
        mc.appendChild(hdr);
        document.getElementById('btnBack').onclick = () => { view = 'home'; render(); };

        // ─ Resolve schedule for this route ─────────────────────────────────
        // FIX: Declare spDates and sched in renderTrips scope so they are
        // available for the trip-card section below (was previously undefined).
        const spDates = S.specialDates();
        const firstTrip = (trips || []).find(tr => tr.destinationId === selDestId);
        // Use the driver's stored license key for schedule lookups.
        // Static trip data uses driverId; registered drivers use driverLicense.
        const routeDriverKey = firstTrip
            ? (firstTrip.driverLicense || ('mock-' + firstTrip.driverId))
            : null;
        const sched = S.schedule(routeDriverKey);

        // Date Picker
        const w = week();
        const picker = el('div', 'date-picker-container animate-in');
        w.forEach((day, idx) => {
            const pill = el('div');
            const effConf = spDates.find(x => x.date === day.iso) || sched[idx];
            const status = effConf ? effConf.status : 'available';
            pill.className = `date-pill${selDateIdx === idx ? ' active' : ''} state-${status}`;
            pill.innerHTML = `<span class="day-name">${t(day.key)}</span><span class="day-num">${day.num}</span>`;
            if (status !== 'off' && effConf) {
                const tag = el('span', '', `🕒 ${fmt12(effConf.time)}`);
                tag.style.cssText = 'font-size:0.6rem;color:var(--text-muted);margin-top:2px;';
                pill.appendChild(tag);
            }
            pill.onclick = () => { selDateIdx = idx; render(); };
            picker.appendChild(pill);
        });
        mc.appendChild(picker);

        // Trip cards filtered by day status
        // FIX: spDates and sched are now properly declared above in this scope.
        const effConf = spDates.find(x => x.date === w[selDateIdx].iso) || sched[selDateIdx];
        const dayStatus = effConf ? effConf.status : 'available';
        const list = el('div', 'card-list');

        } else {
            // Combine Static Trips and Firebase Drivers
            const staticTrips = (trips || []).filter(tr => tr.destinationId === selDestId);
            const firebaseDrivers = Object.values(fbData.drivers)
                .filter(d => d.profile && d.profile.destId === selDestId)
                .map(d => ({
                    ...d.profile,
                    id: d.profile.license,
                    driverLicense: d.profile.license,
                    driverName: d.profile.name,
                    phone: d.profile.phone,
                    isFirebase: true
                }));

            // Filter out static trips that have a firebase equivalent (by license or phone)
            const raw = [
                ...staticTrips.filter(st => !firebaseDrivers.some(fd => fd.phone === st.phone || fd.driverLicense === st.driverLicense)),
                ...firebaseDrivers
            ];

            // If current user is a driver on this route, show them first
            const dl = S.driverLicense(), dd = S.driverDestId();
            if (S.userRole() === 'driver' && dd === selDestId && dl) {
                // Check if already in raw
                if (!raw.find(r => r.driverLicense === dl)) {
                    raw.unshift({ id: '__me__', driverName: S.driverName(), driverLicense: dl, phone: S.driverPhone() });
                }
            }
            
            if (raw.length === 0) {
                list.innerHTML = `<p style="text-align:center;color:var(--text-muted);padding:40px 0;">${t('noTrips')}</p>`;
            } else {
                raw.forEach((trip, i) => {
                    const dKey = trip.driverLicense || ('mock-' + (trip.driverId || trip.id));
                    const dConf = spDates.find(x => x.date === w[selDateIdx].iso) || S.schedule(dKey)[selDateIdx];
                    const card = createTripCard(trip, i, trip.id === '__me__', dConf);
                    if (card) list.appendChild(card);
                });
            }
        }
        mc.appendChild(list);
    }

    function createTripCard(trip, idx, isMe, dayConf) {
        // FIX: Static trips in data.js use driverId not driverLicense.
        // Normalise to a reliable key for schedule and booking lookups.
        const dKey = trip.driverLicense || ('mock-' + (trip.driverId || trip.id));
        const bks = S.bookings();
        const myBk = !isMe && bks.find(b => b.driverLicense === dKey && b.dateIndex === selDateIdx && b.passengerPhone === S.passengerPhone());

        // Guard against a missing dayConf (e.g. no schedule data at all)
        if (!dayConf) return null;

        const card = el('div', 'glass-card trip-card animate-in');
        card.style.animationDelay = `${idx * 0.07}s`;
        card.style.flexDirection = 'column';
        card.style.alignItems = 'stretch';
        card.style.gap = '12px';

        // Top row (Strict Absolute Centering for Activity Icon)
        const top = el('div', 'trip-header');
        top.style.cssText = 'display:flex; justify-content:space-between; align-items:center; width:100%; gap:12px; border-bottom:1px solid rgba(255,255,255,0.05); padding-bottom:12px; position:relative;';
        top.innerHTML = `
            <div class="driver-info" style="flex:1; display:flex; align-items:center; gap:10px;">
                <div class="driver-avatar" style="width:40px;height:40px;background:rgba(255,255,255,0.1);border-radius:50%;display:flex;align-items:center;justify-content:center;border:1px solid rgba(255,255,255,0.1);"><i data-lucide="user"></i></div>
                <div>
                    <div class="driver-name" style="font-weight:700;color:#fff;">${trip.driverName}</div>
                    <div class="digital-clock" style="margin-top:2px;font-size:0.75rem;color:var(--text-muted);">🕒 ${fmt12(isMe ? dayConf.time : (trip.time || '08:30'))}</div>
                </div>
            </div>
            <div style="position:absolute; left:50%; top:50%; transform:translate(-50%, -50%); display:flex; align-items:center;">
                <i data-lucide="activity" style="width:20px; height:20px; color:var(--accent-color); opacity:0.9;"></i>
            </div>
            <div style="flex:1; display:flex; justify-content:flex-end;">
                <div class="seats-indicator ${dayConf.status === 'full' ? 'status-full' : (dayConf.seats <= 2 && dayConf.seats > 0) ? 'status-warn' : 'status-good'}" style="padding:6px 12px; border-radius:10px; font-weight:700; font-size:0.85rem; display:flex; align-items:center; gap:6px;">
                    <div class="seat-dot" style="width:6px; height:6px; border-radius:50%; background:currentColor; box-shadow:0 0 8px currentColor;"></div>
                    ${dayConf.status === 'full' ? t('statusFull') : dayConf.seats + ' ' + t('seatsAvailable')}
                </div>
            </div>`;
        card.appendChild(top);

        // Dynamic Direction Label
        const dirWrap = el('div');
        dirWrap.style.cssText = 'padding:0 8px; margin-top:-4px;';
        const dNameLabel = destName(trip.destinationId || selDestId);
        const headingText = dayConf.direction === 'to_ghardaia' ? t('toGhardaia') : `${t('to')} ${dNameLabel}`;
        dirWrap.innerHTML = `<span style="background:rgba(255,255,255,0.05); color:#fff; font-size:0.8rem; font-weight:700; padding:4px 10px; border-radius:10px; border:1px solid rgba(255,255,255,0.1);">
                <i data-lucide="navigation-2" style="width:12px;height:12px;vertical-align:middle;margin-inline-end:4px;"></i>
                ${t('headingTo')} ${headingText}
            </span>`;
        card.appendChild(dirWrap);

        // Action area
        if (isMe) {
            const tag = el('div', '', `<span style="color:var(--accent-color);font-size:0.85rem;font-weight:600;">${t('myTrips')}</span>`);
            card.appendChild(tag);
        } else if (myBk) {
            const statusKey = myBk.status === 'pending' ? 'requestPending' : 'requestConfirmed';
            const statusColor = myBk.status === 'pending' ? 'var(--warning)' : 'var(--success)';
            const waHtml = myBk.status === 'confirmed'
                ? `<a href="https://wa.me/${trip.phone || ''}?text=${encodeURIComponent(t('waMsg') + ' ' + S.passengerName())}" target="_blank" class="call-btn" style="background:#25D366;justify-content:center;"><i data-lucide="message-circle"></i> ${t('messageWhatsApp')}</a>`
                : '';
            const info = el('div');
            info.innerHTML = `<div style="color:${statusColor};font-weight:700;padding:8px 0;">${t(statusKey)}</div>${waHtml}`;
            card.appendChild(info);
        } else {
            // Book Now button
            const bookBtn = el('button', 'call-btn');
            if (dayConf.status === 'full' || dayConf.seats <= 0) {
                bookBtn.classList.add('btn-full');
                bookBtn.disabled = true;
                bookBtn.innerHTML = `<i data-lucide="slash"></i> ${t('statusFull')}`;
            } else {
                bookBtn.innerHTML = `<i data-lucide="calendar-plus"></i> ${t('bookNow')}`;
                bookBtn.onclick = () => {
                    // Conflict Resolution & Architecture Fix (Real-Time Availability Check)
                    if (!S.isAvailable(dKey, selDateIdx)) {
                        const sched = S.schedule(dKey);
                        sched[selDateIdx].status = 'full';
                        sched[selDateIdx].seats = 0;
                        saveSchedule(dKey, sched);
                        render();
                        return;
                    }

                    const dLicKey = dKey.replace(/\./g, '_');
                    const sched = S.schedule(dKey);
                    const activeSched = sched[selDateIdx];

                    activeSched.seats--;
                    if (activeSched.seats <= 0) {
                        activeSched.seats = 0;
                        activeSched.status = 'full';
                    }
                    saveSchedule(dKey, sched);

                    // Sync Booking to Firebase
                    const newBk = {
                        driverLicense: dKey, 
                        driverName: trip.driverName, 
                        driverPhone: trip.phone || '',
                        passengerName: S.passengerName(), 
                        passengerPhone: S.passengerPhone(),
                        dateIndex: selDateIdx, 
                        status: 'pending',
                        timestamp: Date.now()
                    };
                    const bRef = push(ref(db, 'bookings'));
                    set(bRef, { ...newBk, id: bRef.key });

                    render();
                };
            }
            card.appendChild(bookBtn);
        }

        return card;
    }

    function openDriverNotificationsDialog(pends, sched, dLic) {
        const dialog = el('div', 'tawat-modal animate-in');
        dialog.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);backdrop-filter:blur(8px);z-index:9999;display:flex;flex-direction:column;align-items:center;padding:24px;overflow-y:auto;';

        const hdr = el('div');
        hdr.style.cssText = 'width:100%;max-width:400px;display:flex;justify-content:space-between;align-items:center;margin-bottom:24px;';
        hdr.innerHTML = `
          <h2 style="color:#fff;font-size:1.5rem;font-weight:800;">${t('notifications')}</h2>
          <button id="closeNotesBtn" style="background:rgba(255,255,255,0.2);color:#fff;border:none;width:40px;height:40px;border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;"><i data-lucide="x"></i></button>
      `;
        dialog.appendChild(hdr);

        if (pends.length === 0) {
            const empty = el('div');
            empty.style.cssText = 'color:rgba(255,255,255,0.6);text-align:center;padding:40px 0;';
            empty.innerHTML = `<i data-lucide="bell-off" style="width:48px;height:48px;opacity:0.5;margin-bottom:16px;"></i><br>${t('noTripsOnDate')}`;
            dialog.appendChild(empty);
        } else {
            const list = el('div');
            list.style.cssText = 'width:100%;max-width:400px;display:flex;flex-direction:column;gap:16px;';

            pends.forEach(req => {
                const w = week();
                const day = w[req.dateIndex] || w[0];
                const tTime = (sched[req.dateIndex] && sched[req.dateIndex].time) ? sched[req.dateIndex].time : '08:00';

                const card = el('div', 'glass-card');
                card.style.cssText = 'background:rgba(15,23,42,0.85);border:1px solid rgba(255,255,255,0.1);border-radius:16px;padding:20px;display:flex;flex-direction:column;gap:16px;';

                card.innerHTML = `
                  <div style="display:flex;justify-content:space-between;align-items:flex-start;">
                      <div style="display:flex;gap:12px;align-items:center;">
                          <div style="min-width:48px;height:48px;border-radius:50%;background:linear-gradient(135deg, #3b82f6, #8b5cf6);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:bold;font-size:1.2rem;">
                              ${req.passengerName.charAt(0).toUpperCase()}
                          </div>
                          <div>
                              <div style="color:#fff;font-weight:700;font-size:1.1rem;">${req.passengerName}</div>
                              <div style="color:var(--text-muted);font-size:0.85rem;margin-top:2px;direction:ltr;text-align:right;">${req.passengerPhone}</div>
                          </div>
                      </div>
                      <div style="background:rgba(245,158,11,0.2);color:#f59e0b;font-size:0.75rem;font-weight:700;padding:4px 8px;border-radius:12px;white-space:nowrap;">
                          ${t('newNotification')}
                      </div>
                  </div>
                  
                  <div style="background:rgba(0,0,0,0.3);border-radius:12px;padding:12px;display:flex;justify-content:space-between;align-items:center;">
                      <div style="color:#fff;font-size:0.9rem;">
                          <i data-lucide="calendar" style="width:16px;height:16px;vertical-align:middle;margin-inline-end:4px;color:var(--accent-color);"></i>
                          ${t(day.key)} ${day.num}
                      </div>
                      <div style="color:#fff;font-size:0.9rem;font-weight:bold;">
                          <i data-lucide="clock" style="width:16px;height:16px;vertical-align:middle;margin-inline-end:4px;color:var(--accent-color);"></i>
                          ${fmt12(tTime)}
                      </div>
                  </div>

                  <div style="display:flex;gap:12px;">
                      <a href="tel:${req.passengerPhone}" style="flex:1;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#fff;border-radius:12px;padding:12px;display:flex;justify-content:center;align-items:center;gap:8px;text-decoration:none;font-weight:600;transition:0.2s;">
                          <i data-lucide="phone"></i>
                      </a>
                      <a href="https://wa.me/${req.passengerPhone.replace(/^0/, '213')}?text=${encodeURIComponent(t('waMsg') + ' ' + S.driverName())}" target="_blank" style="flex:1;background:rgba(37,211,102,0.1);border:1px solid rgba(37,211,102,0.3);color:#25d366;border-radius:12px;padding:12px;display:flex;justify-content:center;align-items:center;gap:8px;text-decoration:none;font-weight:600;transition:0.2s;">
                          <i data-lucide="message-circle"></i>
                      </a>
                  </div>
                  
                  <div style="display:flex;gap:12px;">
                      <button class="acc-btn" style="flex:1;background:#28a745;color:#fff;border:none;border-radius:12px;padding:14px;font-weight:bold;font-size:1rem;cursor:pointer;display:flex;justify-content:center;align-items:center;gap:8px;">
                          <i data-lucide="check"></i> ${t('accept')}
                      </button>
                      <button class="dec-btn" style="flex:1;background:#ef4444;color:#fff;border:none;border-radius:12px;padding:14px;font-weight:bold;font-size:1rem;cursor:pointer;display:flex;justify-content:center;align-items:center;gap:8px;">
                          <i data-lucide="x"></i> ${t('decline')}
                      </button>
                  </div>
              `;

                card.querySelector('.acc-btn').onclick = () => {
                    if (req.id) {
                        update(ref(db, `bookings/${req.id}`), { status: 'confirmed' });
                        document.body.removeChild(dialog);
                        render();
                    }
                };

                card.querySelector('.dec-btn').onclick = () => {
                    if (req.id) {
                        update(ref(db, `bookings/${req.id}`), { status: 'cancelled' });
                        
                        // Re-increment seats if booking is declined/cancelled
                        const dLicKey = dLic.replace(/\./g, '_');
                        const activeSched = sched[req.dateIndex] || sched[0];
                        activeSched.seats++;
                        if (activeSched.status === 'full') activeSched.status = 'available';
                        
                        saveSchedule(dLic, sched);
                        document.body.removeChild(dialog);
                        render();
                    }
                };

                list.appendChild(card);
            });
            dialog.appendChild(list);
        }

        document.body.appendChild(dialog);
        if (window.lucide) lucide.createIcons();

        dialog.querySelector('#closeNotesBtn').onclick = () => {
            document.body.removeChild(dialog);
        };
    }

    function openDriverProfileDialog() {
        const dialog = el('div', 'tawat-modal animate-in');
        dialog.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.73);backdrop-filter:blur(12px);z-index:9999;display:flex;flex-direction:column;align-items:center;padding:24px;overflow-y:auto;';

        const allBks = S.bookings();
        const dLic = S.driverLicense();
        const confirmedTrips = allBks.filter(b => b.driverLicense === dLic && b.status === 'confirmed').length;

        const hdr = el('div');
        hdr.style.cssText = 'width:100%;max-width:400px;display:flex;justify-content:space-between;align-items:center;margin-bottom:32px;';
        hdr.innerHTML = `
          <h2 style="color:#fff;font-size:1.5rem;font-weight:800;">${t('driverProfile')}</h2>
          <button id="closeProfileBtn" style="background:rgba(255,255,255,0.2);color:#fff;border:none;width:40px;height:40px;border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;"><i data-lucide="x"></i></button>
      `;
        dialog.appendChild(hdr);

        const content = el('div');
        content.style.cssText = 'width:100%;max-width:400px;display:flex;flex-direction:column;align-items:center;gap:24px;';
        content.innerHTML = `
          <div style="position:relative;">
              <div style="width:120px;height:120px;border-radius:50%;background:linear-gradient(135deg, var(--accent-color), #3b82f6);display:flex;align-items:center;justify-content:center;border:4px solid rgba(255,255,255,0.1);box-shadow:0 10px 25px rgba(0,0,0,0.3);">
                  <i data-lucide="user" style="width:60px;height:60px;color:#fff;"></i>
              </div>
              <div style="position:absolute;bottom:5px;right:5px;width:24px;height:24px;background:#22c55e;border-radius:50%;border:3px solid #0f172a;"></div>
          </div>

          <div style="text-align:center;">
              <h3 style="color:#fff;font-size:1.4rem;font-weight:700;margin:0;">${S.driverName()}</h3>
              <p style="color:var(--text-muted);font-size:1rem;margin:4px 0 0;direction:ltr;">${S.driverPhone()}</p>
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;width:100%;">
              <div style="background:rgba(255,255,255,0.05);padding:16px;border-radius:16px;text-align:center;border:1px solid rgba(255,255,255,0.05);">
                  <div style="color:var(--accent-color);font-size:1.2rem;font-weight:800;">${confirmedTrips}</div>
                  <div style="color:var(--text-muted);font-size:0.75rem;font-weight:600;margin-top:4px;">${t('totalTrips')}</div>
              </div>
              <div style="background:rgba(255,255,255,0.05);padding:16px;border-radius:16px;text-align:center;border:1px solid rgba(255,255,255,0.05);">
                  <div style="color:#f59e0b;font-size:1.2rem;font-weight:800;">4.9</div>
                  <div style="color:var(--text-muted);font-size:0.75rem;font-weight:600;margin-top:4px;">${t('rating')}</div>
              </div>
          </div>

          <div class="glass-card" style="flex-direction:column;align-items:stretch;gap:16px;padding:20px;width:100%;background:rgba(255,255,255,0.03);">
              <div style="display:flex;justify-content:space-between;align-items:center;">
                  <span style="color:var(--text-muted);font-weight:600;">${t('carDetails')}</span>
                  <span style="color:#fff;font-weight:700;">${S.driverColor()}</span>
              </div>
              <div style="height:1px;background:rgba(255,255,255,0.05);"></div>
              <div style="display:flex;justify-content:space-between;align-items:center;">
                  <span style="color:var(--text-muted);font-weight:600;">${t('licensePlate')}</span>
                  <span style="color:#fff;font-weight:700;direction:ltr;">${S.driverLicense()}</span>
              </div>
              <div style="height:1px;background:rgba(255,255,255,0.05);"></div>
              <div style="display:flex;justify-content:space-between;align-items:center;">
                  <span style="color:var(--text-muted);font-weight:600;">${t('activeStatus')}</span>
                  <span style="color:#22c55e;font-weight:700;">${t('statusAvailable')}</span>
              </div>
          </div>

          <button id="profileLogoutBtn" style="width:100%;background:#dc3545;color:#fff;border:none;border-radius:14px;padding:16px;font-weight:800;font-size:1.1rem;cursor:pointer;display:flex;justify-content:center;align-items:center;gap:10px;margin-top:16px;box-shadow:0 10px 20px rgba(220,53,69,0.2);">
              <i data-lucide="log-out"></i> ${t('logout')}
          </button>
      `;
        dialog.appendChild(content);
        document.body.appendChild(dialog);
        if (window.lucide) lucide.createIcons();

        dialog.querySelector('#closeProfileBtn').onclick = () => document.body.removeChild(dialog);
        dialog.querySelector('#profileLogoutBtn').onclick = () => {
            localStorage.clear();
            location.reload();
        };
    }

    function renderDriverDash() {
        const dName = S.driverName(); // eslint-disable-line no-unused-vars
        const dLic = S.driverLicense();
        const dDestId = S.driverDestId();
        const dDestName = destName(dDestId);
        let sched = S.schedule(dLic);
        const spDates = S.specialDates();
        const allBks = S.bookings();

        // ── Header ──
        const allPends = allBks.filter(b => b.driverLicense === dLic && b.status === 'pending');

        const hdr = el('div', 'view-header animate-in');
        hdr.style.gap = '16px';
        hdr.innerHTML = `
            <button class="back-btn" id="btnDriverDashBack"><i data-lucide="arrow-left"></i></button>
            <div style="flex:1;">
                <h1 class="view-title">${t('driverDashboard')}</h1>
                <div style="color:var(--accent-color);font-size:0.85rem;font-weight:600;margin-top:2px;">
                    <i data-lucide="map-pin" style="width:14px;height:14px;vertical-align:middle;"></i>
                    Ghardaia ↔ ${dDestName}
                </div>
                <div style="color:var(--text-muted);font-size:0.75rem;margin-top:2px;">${dLic}</div>
            </div>
            <div style="display:flex; gap:12px; align-items:center;">
                <div style="position:relative; cursor:pointer;" id="btnDriverNotes">
                    <div style="width:44px; height:44px; border-radius:50%; background:rgba(255,255,255,0.1); display:flex; align-items:center; justify-content:center; backdrop-filter:blur(10px);">
                        <i data-lucide="bell" style="width:24px; height:24px; color:#fff;"></i>
                    </div>
                    ${allPends.length > 0 ? `<div style="position:absolute; top:-2px; right:-2px; background:#ef4444; color:#fff; font-size:10px; font-weight:bold; width:20px; height:20px; border-radius:50%; display:flex; align-items:center; justify-content:center; border:2px solid var(--bg-color);">${allPends.length}</div>` : ''}
                </div>
                <div style="width:44px; height:44px; border-radius:50%; background:var(--accent-color); display:flex; align-items:center; justify-content:center; cursor:pointer; box-shadow:0 4px 12px rgba(0,0,0,0.2);" id="btnDriverProfile">
                    <i data-lucide="user" style="width:24px; height:24px; color:#fff;"></i>
                </div>
            </div>`;
        mc.appendChild(hdr);
        document.getElementById('btnDriverDashBack').onclick = () => { view = 'onboarding'; render(); };
        document.getElementById('btnDriverNotes').onclick = () => {
            openDriverNotificationsDialog(allPends, sched, dLic);
        };
        document.getElementById('btnDriverProfile').onclick = () => {
            openDriverProfileDialog();
        };

        // ── Tabs ──
        const tabs = el('div', 'driver-tabs animate-in');
        ['today', 'weekly', 'history'].forEach(tabId => {
            const titleMap = { today: t('todayTrips'), weekly: t('weeklySchedule'), history: t('historyAll') };
            const btn = el('button', `driver-tab-btn ${driverActiveTab === tabId ? 'active' : ''}`, titleMap[tabId]);
            btn.onclick = () => {
                driverActiveTab = tabId;
                driverSearchQuery = '';
                render();
            };
            tabs.appendChild(btn);
        });
        mc.appendChild(tabs);

        // ── Filter/Search Bar ──
        const sBar = el('div', 'search-bar-container animate-in');
        sBar.style.marginTop = '16px';
        sBar.innerHTML = `
        <i data-lucide="search" style="color:var(--text-muted);width:20px;height:20px;"></i>
        <input type="text" class="search-input" id="driverSearch" placeholder="${t('searchFilterPlaceholder')}" value="${driverSearchQuery}">
    `;
        mc.appendChild(sBar);
        setTimeout(() => {
            const inp = document.getElementById('driverSearch');
            if (inp && document.activeElement !== inp) {
                const val = inp.value;
                inp.focus(); inp.value = ''; inp.value = val;
                inp.oninput = (e) => { driverSearchQuery = e.target.value.toLowerCase(); render(); };
            }
        }, 0);

        const q = driverSearchQuery.trim().toLowerCase();

        function dateMatches(isoStr, query) {
            if (!query) return true;
            if (!isoStr) return false;
            const parts = isoStr.split('-');
            if (parts.length !== 3) return false;
            const [y, m, d] = parts;
            const variants = [
                `${d}.${m}.${y}`, `${d}/${m}/${y}`, `${d}-${m}-${y}`,
                `${d}.${m}`, `${d}/${m}`, `${d}-${m}`,
                isoStr
            ];
            return variants.some(v => v.includes(query)) || query.includes(isoStr);
        }

        // ── Accordion Helper ──
        function createAccordion(id, mainTitle, subTitle, contentHTML) {
            const item = el('div', 'accordion-item animate-in');
            item.innerHTML = `
            <div class="accordion-header" id="accHdr_${id}">
                <div>
                    <div style="color:var(--accent-color);font-weight:700;font-size:1rem;">${mainTitle}</div>
                    <div style="font-size:0.8rem;color:var(--text-muted);margin-top:4px;">${subTitle}</div>
                </div>
                <i data-lucide="chevron-down" class="accordion-chevron"></i>
            </div>
            <div class="accordion-content" id="accCtx_${id}">
                ${contentHTML}
            </div>
        `;
            item.querySelector('.accordion-header').onclick = () => {
                item.classList.toggle('open');
                if (window.lucide) lucide.createIcons();
            };
            return item;
        }

        const bgColors = { 'available': '#28a745', 'full': '#dc3545', 'off': '#6c757d' };

        // ── Tabs Logic ──
        if (driverActiveTab === 'today') {
            const w = week();
            const todayIso = w[0].iso;
            const effConf = spDates.find(x => x.date === todayIso) || sched[0];

            // Render today's route
            let todayItemsRendered = 0;
            if (`${t(w[0].key)} ${w[0].num}`.toLowerCase().includes(q) || dDestName.toLowerCase().includes(q) || dateMatches(todayIso, q)) {
                todayItemsRendered++;
                const curColor = bgColors[effConf.status] || 'rgba(0,0,0,0.3)';
                const content = `
                <div style="display:flex; flex-direction:column; gap:20px; width:100%;">
                    <div style="display:flex; justify-content:space-between; align-items:center; width:100%; gap:10px;">
                        <div style="display:flex; align-items:center; gap:8px; flex:1;">
                            <i data-lucide="users" class="schedule-icon"></i>
                            <select class="modern-dropdown seat-dropdown" disabled title="${t('seats')}" style="background-color:rgba(0,0,0,0.3); width:60px;">
                                <option value="${effConf.seats}" selected>${effConf.seats}</option>
                            </select>
                        </div>
                        <div style="position:relative; display:flex; align-items:center; justify-content:center;">
                            <i data-lucide="activity" style="width:20px; height:20px; color:var(--accent-color); opacity:0.9;"></i>
                        </div>
                        <div style="display:flex; align-items:center; gap:8px; flex:1; justify-content:flex-end;">
                            <select class="modern-dropdown" style="background-color:${curColor}; width:130px; border:none;" disabled>
                                <option value="available" ${effConf.status === 'available' ? 'selected' : ''}>${t('statusAvailable')}</option>
                                <option value="full"      ${effConf.status === 'full' ? 'selected' : ''}>${t('statusFull')}</option>
                                <option value="off"       ${effConf.status === 'off' ? 'selected' : ''}>${t('statusOff')}</option>
                            </select>
                        </div>
                    </div>
                    <div style="display:flex; justify-content:center; align-items:center; width:100%; color:#ffffff; font-weight:800; font-size:1.1rem; gap:10px;">
                        <i data-lucide="${effConf.direction === 'to_ghardaia' ? 'navigation' : 'map-pin'}" style="width:22px;height:22px;color:var(--accent-color);"></i>
                        <span>${effConf.direction === 'to_ghardaia' ? t('toGhardaia') : `${t('to')} ${dDestName}`}</span>
                    </div>
                    <div style="display:flex; justify-content:center; align-items:center; width:100%; position:relative; min-height:8px; margin:4px 0;">
                        <div style="height:1px; background:rgba(255,255,255,0.08); width:100%;"></div>
                    </div>
                    <div style="display:flex; justify-content:center; align-items:center; gap:12px; width:100%;">
                        <i data-lucide="clock" class="schedule-icon" style="color:var(--accent-color);"></i>
                        <input type="time" class="time-input-premium" disabled value="${effConf.time}" style="width:160px;text-align:center;border-color:rgba(255,255,255,0.1);" />
                    </div>
                </div>`;
                const acc = createAccordion('today_route', `${t(w[0].key)} ${w[0].num} (${t('todayTrips')})`, `🕒 ${fmt12(effConf.time)}`, content);
                acc.classList.add('open'); // Today is expanded by default
                mc.appendChild(acc);
            }

            // Render today's requests
            let todayReqsRendered = 0;
            const reqs = allBks.filter(b => b.driverLicense === dLic && (b.status === 'pending' || b.status === 'confirmed') && b.dateIndex === 0);
            reqs.forEach(req => {
                if (req.passengerName.toLowerCase().includes(q) || req.passengerPhone.includes(q)) {
                    todayReqsRendered++;
                    const pcard = el('div', 'glass-card animate-in');
                    pcard.style.cssText = 'flex-direction:column;gap:8px;padding:16px;margin-bottom:8px;';
                    pcard.innerHTML = `
                    <div style="display:flex;justify-content:space-between;">
                        <div>
                            <div style="font-weight:700;">${req.passengerName}</div>
                            <div style="font-size:0.8rem;color:var(--text-muted);">${req.passengerPhone}</div>
                        </div>
                        <div style="color:${req.status === 'confirmed' ? '#28a745' : '#f59e0b'};font-weight:700;">
                            ${req.status.toUpperCase()}
                        </div>
                    </div>`;
                    mc.appendChild(pcard);
                }
            });

            if (todayItemsRendered === 0 && todayReqsRendered === 0 && q) {
                const empty = el('div');
                empty.style.cssText = 'text-align:center;padding:24px;color:var(--text-muted);';
                empty.textContent = t('noTripsOnDate');
                mc.appendChild(empty);
            } else if (todayReqsRendered === 0 && !q) {
                const empty = el('div');
                empty.style.cssText = 'text-align:center;padding:24px;color:var(--text-muted);';
                empty.textContent = t('noBookingsToday');
                mc.appendChild(empty);
            }
        }
        else if (driverActiveTab === 'weekly') {
            let weeklyItemsRendered = 0;
            const schedHeader = el('div', 'view-header');
            schedHeader.style.cssText = 'justify-content:space-between; margin:12px 0;';
            const schedTitle = el('h3', 'view-title');
            schedTitle.style.cssText = 'font-size:1.1rem;';
            schedTitle.textContent = t('weeklySchedule');
            const calWrap = el('div');
            calWrap.style.cssText = 'position:relative; display:flex; align-items:center;';
            calWrap.innerHTML = `
            <button class="icon-btn" style="background:var(--primary-color);color:#FFF;border:none;width:44px;height:44px;" onclick="document.getElementById('specialDatePicker').showPicker()">
                <i data-lucide="calendar"></i>
            </button>
            <input type="date" id="specialDatePicker" style="position:absolute;top:0;left:0;opacity:0;pointer-events:none;width:0;height:0;" min="${new Date().toISOString().split('T')[0]}" />
        `;
            schedHeader.appendChild(schedTitle);
            schedHeader.appendChild(calWrap);
            mc.appendChild(schedHeader);

            setTimeout(() => {
                const dp = document.getElementById('specialDatePicker');
                if (dp) {
                    dp.onchange = (e) => {
                        const dateVal = e.target.value;
                        if (!dateVal) return;
                        if (!spDates.find(x => x.date === dateVal)) {
                            spDates.push({ date: dateVal, status: 'off', seats: 0, time: '08:00' });
                            spDates.sort((a, b) => a.date.localeCompare(b.date));
                            saveSpecialDates(spDates);
                            render();
                        }
                    };
                }
            }, 0);

            week().forEach((day, idx) => {
                const cfg = sched[idx];
                const titleStr = `${t(day.key)} ${day.num}`;
                if (!titleStr.toLowerCase().includes(q) && !dDestName.toLowerCase().includes(q) && !dateMatches(day.iso, q)) return;
                weeklyItemsRendered++;

                const curColor = bgColors[cfg.status] || 'rgba(0,0,0,0.3)';
                const content = `
                <div style="display:flex; flex-direction:column; gap:20px; width:100%;">
                    <div style="display:flex; justify-content:space-between; align-items:center; width:100%; gap:10px;">
                        <div style="display:flex; align-items:center; gap:8px; flex:1;">
                            ${cfg.status === 'available' ? `
                                <i data-lucide="users" class="schedule-icon"></i>
                                <select class="modern-dropdown seat-dropdown" id="seat${idx}" title="${t('seats')}" style="background-color:rgba(0,0,0,0.3); width:60px;">
                                    ${[1, 2, 3, 4, 5, 6, 7, 8].map(n => `<option value="${n}" ${cfg.seats == n ? 'selected' : ''}>${n}</option>`).join('')}
                                </select>
                            ` : ''}
                        </div>
                        <div style="position:relative; display:flex; align-items:center; justify-content:center;">
                            <i data-lucide="activity" style="width:20px; height:20px; color:var(--accent-color); opacity:0.9;"></i>
                        </div>
                        <div style="display:flex; align-items:center; gap:8px; flex:1; justify-content:flex-end;">
                            <select id="stat${idx}" class="modern-dropdown" style="background-color:${curColor}; width:130px; border:none;">
                                <option value="available" ${cfg.status === 'available' ? 'selected' : ''}>${t('statusAvailable')}</option>
                                <option value="full"      ${cfg.status === 'full' ? 'selected' : ''}>${t('statusFull')}</option>
                                <option value="off"       ${cfg.status === 'off' ? 'selected' : ''}>${t('statusOff')}</option>
                            </select>
                        </div>
                    </div>
                    
                    <div style="display:flex; justify-content:center; align-items:center; width:100%; flex-direction:column; gap:8px;">
                        <select id="dir${idx}" class="modern-dropdown" style="width:100%; max-width:240px; text-align:center; font-weight:700; background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.1);">
                            <option value="to_dest"     ${cfg.direction === 'to_dest' ? 'selected' : ''}>${t('to')} ${dDestName}</option>
                            <option value="to_ghardaia" ${cfg.direction === 'to_ghardaia' ? 'selected' : ''}>${t('toGhardaia')}</option>
                        </select>
                    </div>

                    <div style="display:flex; justify-content:center; align-items:center; width:100%; position:relative; min-height:8px; margin:4px 0;">
                        <div style="height:1px; background:rgba(255,255,255,0.05); width:100%;"></div>
                    </div>

                    <div style="display:flex; justify-content:center; align-items:center; gap:12px; width:100%;">
                        <i data-lucide="clock" class="schedule-icon"></i>
                        <input type="time" class="time-input-premium" id="tim${idx}" value="${cfg.time}" title="${t('timeSlot')}" style="width:160px;text-align:center;" />
                    </div>
                </div>`;

                const acc = createAccordion(`wk_${idx}`, titleStr, `🕒 ${fmt12(cfg.time)}`, content);
                setTimeout(() => {
                    const timeInp = document.getElementById(`tim${idx}`);
                    if (timeInp) timeInp.onchange = (e) => { sched[idx].time = e.target.value; saveSchedule(dLic, sched); };
                    const dirInp = document.getElementById(`dir${idx}`);
                    if (dirInp) dirInp.onchange = (e) => { sched[idx].direction = e.target.value; saveSchedule(dLic, sched); render(); };
                    const seatInp = document.getElementById(`seat${idx}`);
                    if (seatInp) seatInp.onchange = (e) => { sched[idx].seats = Math.max(1, Math.min(8, parseInt(e.target.value) || 1)); saveSchedule(dLic, sched); };
                    const statSel = document.getElementById(`stat${idx}`);
                    if (statSel) statSel.onchange = (e) => {
                        sched[idx].status = e.target.value;
                        if (e.target.value === 'full') sched[idx].seats = 0;
                        if (e.target.value === 'available' && sched[idx].seats === 0) sched[idx].seats = 8;
                        saveSchedule(dLic, sched); render();
                    };
                }, 0);
                mc.appendChild(acc);
            });

            if (spDates.length > 0) {
                const hasSpecialMatches = spDates.some(cfg => cfg.date.includes(q) || dDestName.toLowerCase().includes(q) || dateMatches(cfg.date, q));
                if (hasSpecialMatches) {
                    const spTitle = el('h3', 'view-title');
                    spTitle.style.cssText = 'font-size:1.1rem;margin:24px 0 12px; color:var(--warning);';
                    spTitle.textContent = t('specialDatesBlocked');
                    mc.appendChild(spTitle);
                }

                spDates.forEach((cfg, idx) => {
                    if (!cfg.date.includes(q) && !dDestName.toLowerCase().includes(q) && !dateMatches(cfg.date, q)) return;
                    weeklyItemsRendered++;
                    const curColor = bgColors[cfg.status] || 'rgba(0,0,0,0.3)';
                    const content = `
                <div style="display:flex; flex-direction:column; gap:20px; width:100%;">
                    <div style="display:flex; justify-content:space-between; align-items:center; width:100%; gap:10px;">
                        <div style="display:flex; align-items:center; gap:8px; flex:1;">
                            ${cfg.status === 'available' ? `
                                <i data-lucide="users" class="schedule-icon"></i>
                                <select class="modern-dropdown seat-dropdown" id="spSeat${idx}" title="${t('seats')}" style="background-color:rgba(0,0,0,0.3); width:60px;">
                                    ${[1, 2, 3, 4, 5, 6, 7, 8].map(n => `<option value="${n}" ${cfg.seats == n ? 'selected' : ''}>${n}</option>`).join('')}
                                </select>
                            ` : ''}
                        </div>
                        <div style="position:relative; display:flex; align-items:center; justify-content:center;">
                            <i data-lucide="activity" style="width:20px; height:20px; color:var(--accent-color); opacity:0.9;"></i>
                        </div>
                        <div style="display:flex; align-items:center; gap:8px; flex:1; justify-content:flex-end;">
                            <select id="spStat${idx}" class="modern-dropdown" style="background-color:${curColor}; width:130px; border:none;">
                                <option value="available" ${cfg.status === 'available' ? 'selected' : ''}>${t('statusAvailable')}</option>
                                <option value="full"      ${cfg.status === 'full' ? 'selected' : ''}>${t('statusFull')}</option>
                                <option value="off"       ${cfg.status === 'off' ? 'selected' : ''}>${t('statusOff')}</option>
                            </select>
                            <button class="icon-btn" id="spDel${idx}" style="background-color:rgba(239,68,68,0.2);color:#ef4444;width:44px;height:44px;border-radius:12px;border:none;cursor:pointer;">
                                <i data-lucide="trash-2" style="width:20px;height:20px;"></i>
                            </button>
                        </div>
                    </div>
                    
                    <div style="display:flex; justify-content:center; align-items:center; width:100%; flex-direction:column; gap:8px;">
                        <select id="spDir${idx}" class="modern-dropdown" style="width:100%; max-width:240px; text-align:center; font-weight:700; background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.1);">
                            <option value="to_dest"     ${cfg.direction === 'to_dest' ? 'selected' : ''}>${t('to')} ${dDestName}</option>
                            <option value="to_ghardaia" ${cfg.direction === 'to_ghardaia' ? 'selected' : ''}>${t('toGhardaia')}</option>
                        </select>
                    </div>

                    <div style="display:flex; justify-content:center; align-items:center; width:100%; position:relative; min-height:8px; margin:4px 0;">
                        <div style="height:1px; background:rgba(255,255,255,0.05); width:100%;"></div>
                    </div>

                    <div style="display:flex; justify-content:center; align-items:center; gap:12px; width:100%;">
                        <i data-lucide="clock" class="schedule-icon"></i>
                        <input type="time" class="time-input-premium" id="spTim${idx}" value="${cfg.time}" title="${t('timeSlot')}" style="width:160px;text-align:center;" />
                    </div>
                </div>`;

                    const acc = createAccordion(`sp_${idx}`, cfg.date, `🕒 ${fmt12(cfg.time)}`, content);
                    setTimeout(() => {
                        const timeInp = document.getElementById(`spTim${idx}`);
                        if (timeInp) timeInp.onchange = (e) => { spDates[idx].time = e.target.value; saveSpecialDates(spDates); };
                        const dirInp = document.getElementById(`spDir${idx}`);
                        if (dirInp) dirInp.onchange = (e) => { spDates[idx].direction = e.target.value; saveSpecialDates(spDates); render(); };
                        const seatInp = document.getElementById(`spSeat${idx}`);
                        if (seatInp) seatInp.onchange = (e) => { spDates[idx].seats = Math.max(1, Math.min(8, parseInt(e.target.value) || 1)); saveSpecialDates(spDates); };
                        const statSel = document.getElementById(`spStat${idx}`);
                        if (statSel) statSel.onchange = (e) => {
                            spDates[idx].status = e.target.value;
                            if (e.target.value === 'full') spDates[idx].seats = 0;
                            if (e.target.value === 'available' && spDates[idx].seats === 0) spDates[idx].seats = 8;
                            saveSpecialDates(spDates); render();
                        };
                        const delBtn = document.getElementById(`spDel${idx}`);
                        if (delBtn) delBtn.onclick = () => { spDates.splice(idx, 1); saveSpecialDates(spDates); render(); };
                    }, 0);
                    mc.appendChild(acc);
                });
            }

            if (weeklyItemsRendered === 0 && q) {
                const empty = el('div');
                empty.style.cssText = 'text-align:center;padding:24px;color:var(--text-muted);';
                empty.textContent = t('noTripsOnDate');
                mc.appendChild(empty);
            }
        }
        else if (driverActiveTab === 'history') {
            let histItemsRendered = 0;
            const hist = allBks.filter(b => b.driverLicense === dLic && (b.status === 'confirmed' || b.status === 'cancelled'));
            hist.forEach(req => {
                const w = week();
                const dateRef = w[req.dateIndex] ? `${t(w[req.dateIndex].key)} ${w[req.dateIndex].num}` : t('pastDate');
                const dateIso = w[req.dateIndex] ? w[req.dateIndex].iso : '';
                if (!dateRef.toLowerCase().includes(q) && !req.passengerName.toLowerCase().includes(q) && !dateMatches(dateIso, q)) return;

                histItemsRendered++;
                const pcard = el('div', 'glass-card animate-in');
                pcard.style.cssText = 'flex-direction:column;gap:8px;padding:16px;margin-bottom:8px;';
                pcard.innerHTML = `
                <div style="display:flex;justify-content:space-between;align-items:center;">
                    <div>
                        <div style="font-weight:700;">${req.passengerName}</div>
                        <div style="color:var(--text-muted);font-size:0.8rem;">${req.passengerPhone}</div>
                        <div style="color:var(--accent-color);font-size:0.8rem;margin-top:4px;">${dateRef}</div>
                    </div>
                    <div>
                        <span style="font-weight:800; font-size:0.85rem; padding:6px 12px; border-radius:8px; background:${req.status === 'confirmed' ? 'rgba(40,167,69,0.2)' : 'rgba(239,68,68,0.2)'}; color:${req.status === 'confirmed' ? '#28a745' : '#ef4444'};">${req.status.toUpperCase()}</span>
                    </div>
                </div>`;
                mc.appendChild(pcard);
            });

            if (histItemsRendered === 0) {
                const empty = el('div');
                empty.style.cssText = 'text-align:center;padding:24px;color:var(--text-muted);';
                empty.textContent = q ? t('noTripsOnDate') : t('noPastTrips');
                mc.appendChild(empty);
            }
        }

        // Profile system is now integrated in high-end modal
    }


    function renderProfile() {
        mc.innerHTML = `
            <div class="view-header animate-in">
                <button class="back-btn" id="btnBack"><i data-lucide="arrow-left"></i> ${t('back')}</button>
                <h1 class="view-title" style="flex:1; text-align:center; margin-inline-end:44px;">${t('myProfile')}</h1>
            </div>`;
        document.getElementById('btnBack').onclick = () => { view = resolveInitialView() === 'driver' ? 'driver' : 'home'; render(); };

        const wrap = el('div', 'login-container animate-in');
        wrap.innerHTML = `
            <div class="glass-card" style="flex-direction:column;gap:14px;padding:24px;">
                <div><input id="profName"  class="glass-input" type="text" value="${S.passengerName()}" placeholder="${t('enterFullName')}" style="padding:14px;" /></div>
                <div><input id="profPhone" class="glass-input" type="tel"  value="${S.passengerPhone()}" placeholder="0X XX XX XX XX" maxlength="10" style="padding:14px;" /></div>
                <button id="profSave" class="call-btn">${t('save')}</button>
                <button id="profOut"  class="call-btn" style="background:rgba(239,68,68,.1);color:#ef4444;border:1px solid rgba(239,68,68,.3);">${t('logout')}</button>
            </div>`;
        mc.appendChild(wrap);

        const pNameInp = document.getElementById('profName');
        const pPhoneInp = document.getElementById('profPhone');
        pNameInp.oninput = () => clearError('profName');
        pPhoneInp.oninput = () => { clearError('profPhone'); pPhoneInp.value = pPhoneInp.value.replace(/\D/g, '').slice(0, 10); };

        document.getElementById('profSave').onclick = () => {
            const n = pNameInp.value.trim();
            const p = pPhoneInp.value.trim();
            let valid = true;
            if (!validateName(n)) { showError('profName', t('errorName')); valid = false; }
            if (!validatePhone(p)) { showError('profPhone', t('errorPhone')); valid = false; }
            if (!valid) return;
            localStorage.setItem('passengerName', n);
            localStorage.setItem('passengerPhone', p);
            view = 'home'; render();
        };
        document.getElementById('profOut').onclick = () => { localStorage.clear(); location.reload(); };
    }

    // ── Setup initial view ───────────────────────────────────────────────────
    function resolveInitialView() {
        const role = S.userRole();
        if (!role) return 'onboarding';
        if (role === 'driver') return (S.driverName() && S.driverLicense() && S.driverDestId()) ? 'driver' : 'driverReg';
        return S.passengerName() ? 'home' : 'login';
    }

    // ── Wire up controls ─────────────────────────────────────────────────────
    if (langSel) {
        langSel.value = window.currentLang;
        langSel.onchange = e => { setLang(e.target.value); render(); };
    }
    if (profBtn) profBtn.onclick = () => { view = 'profile'; render(); };

    // ── Kickoff with Professional Splash V4 (Dashboard Transition) ──────────
    view = resolveInitialView();
    if (view !== 'onboarding') document.body.classList.add('content-loading');

    runSplash(() => {
        render();
    });

})();
