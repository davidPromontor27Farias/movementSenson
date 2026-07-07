/**
 * MovementLock
 * ------------
 * Bloquea la interacción con la página cuando el dispositivo se mueve
 * a una velocidad >= thresholdKmH (por defecto 1 km/h).
 *
 * Fuente de velocidad: Geolocation API.
 *  - Si el navegador reporta coords.speed (m/s), se usa directamente.
 *  - Si no, se calcula por distancia (Haversine) / tiempo entre dos fixes.
 *
 * Por qué hace falta filtrado: a 1 km/h el ruido normal del GPS
 * (que puede "saltar" varios metros entre lecturas) generaría falsos
 * positivos constantes. Por eso se descartan fixes con accuracy pobre
 * y se exige N lecturas consecutivas por encima del umbral antes de
 * bloquear.
 */
(function (global) {
  const EARTH_RADIUS_M = 6371000;

  function toRad(deg) {
    return (deg * Math.PI) / 180;
  }

  function haversineMeters(lat1, lon1, lat2, lon2) {
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
  }

  async function sha256Hex(text) {
    const data = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  class MovementLock {
    /**
     * @param {Object} options
     * @param {number} options.thresholdKmH - velocidad a partir de la cual se bloquea.
     * @param {number} options.consecutiveSamplesRequired - lecturas seguidas por encima del umbral antes de bloquear.
     * @param {number} options.minAccuracyMeters - se ignoran fixes GPS con accuracy peor que esto.
     * @param {number} options.releaseGraceSeconds - segundos sin movimiento tras un desbloqueo antes de permitir re-bloqueo (evita parpadeo).
     * @param {string} options.pinHash - SHA-256 hex del PIN de administrador.
     * @param {string} options.storageKey - clave de localStorage para persistir el estado de bloqueo.
     */
    constructor(options = {}) {
      this.thresholdKmH = options.thresholdKmH ?? 1;
      this.consecutiveSamplesRequired = options.consecutiveSamplesRequired ?? 3;
      this.minAccuracyMeters = options.minAccuracyMeters ?? 30;
      this.pinHash = options.pinHash;
      this.storageKey = options.storageKey ?? 'movementlock_state';

      this.watchId = null;
      this.lastPosition = null;
      this.aboveThresholdCount = 0;
      this.locked = false;
      this.onLock = options.onLock ?? (() => {});
      this.onUnlock = options.onUnlock ?? (() => {});
      this.onStatus = options.onStatus ?? (() => {});

      this._buildOverlay();
      this._restoreState();
    }

    start() {
      if (!('geolocation' in navigator)) {
        this.onStatus('Geolocation API no disponible en este navegador.');
        return;
      }
      this.watchId = navigator.geolocation.watchPosition(
        (pos) => this._handlePosition(pos),
        (err) => this._handleError(err),
        { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }
      );
      this.onStatus('Monitoreo de movimiento activo.');
    }

    stop() {
      if (this.watchId !== null) {
        navigator.geolocation.clearWatch(this.watchId);
        this.watchId = null;
      }
    }

    _handlePosition(pos) {
      const { latitude, longitude, speed, accuracy } = pos.coords;
      const timestamp = pos.timestamp;

      if (accuracy != null && accuracy > this.minAccuracyMeters) {
        this.onStatus(`Fix GPS descartado (accuracy ${Math.round(accuracy)}m).`);
        return;
      }

      let speedKmH = null;
      if (typeof speed === 'number' && speed !== null && !Number.isNaN(speed)) {
        speedKmH = speed * 3.6;
      } else if (this.lastPosition) {
        const distanceM = haversineMeters(
          this.lastPosition.lat,
          this.lastPosition.lon,
          latitude,
          longitude
        );
        const dtSeconds = (timestamp - this.lastPosition.timestamp) / 1000;
        if (dtSeconds > 0) {
          speedKmH = (distanceM / dtSeconds) * 3.6;
        }
      }

      this.lastPosition = { lat: latitude, lon: longitude, timestamp };

      if (speedKmH === null) return;

      this.onStatus(`Velocidad estimada: ${speedKmH.toFixed(2)} km/h`);

      if (speedKmH >= this.thresholdKmH) {
        this.aboveThresholdCount += 1;
        if (this.aboveThresholdCount >= this.consecutiveSamplesRequired && !this.locked) {
          this._lock();
        }
      } else {
        this.aboveThresholdCount = 0;
      }
    }

    _handleError(err) {
      this.onStatus(`Error de geolocalización: ${err.message}`);
    }

    _lock() {
      this.locked = true;
      this._persistState();
      this._showOverlay();
      this.onLock();
    }

    async _tryUnlock(pin) {
      if (!this.pinHash) return false;
      const hash = await sha256Hex(pin);
      if (hash === this.pinHash) {
        this.locked = false;
        this.aboveThresholdCount = 0;
        this._persistState();
        this._hideOverlay();
        this.onUnlock();
        return true;
      }
      return false;
    }

    _persistState() {
      try {
        localStorage.setItem(this.storageKey, JSON.stringify({ locked: this.locked }));
      } catch (e) {
        /* localStorage puede no estar disponible (modo privado, etc.) */
      }
    }

    _restoreState() {
      try {
        const raw = localStorage.getItem(this.storageKey);
        if (raw) {
          const state = JSON.parse(raw);
          if (state.locked) {
            this.locked = true;
            this._showOverlay();
          }
        }
      } catch (e) {
        /* estado corrupto o localStorage no disponible: se ignora */
      }
    }

    _buildOverlay() {
      const overlay = document.createElement('div');
      overlay.className = 'movementlock-overlay';
      overlay.setAttribute('role', 'alertdialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.innerHTML = `
        <div class="movementlock-card">
          <h1>Dispositivo bloqueado</h1>
          <p>Se detectó movimiento. Ingresa el PIN de administrador para desbloquear.</p>
          <form class="movementlock-form">
            <input type="password" inputmode="numeric" autocomplete="off"
                   class="movementlock-pin" placeholder="PIN" aria-label="PIN" />
            <button type="submit">Desbloquear</button>
          </form>
          <p class="movementlock-error" hidden>PIN incorrecto.</p>
        </div>
      `;
      document.body.appendChild(overlay);
      this.overlayEl = overlay;
      this.pinInputEl = overlay.querySelector('.movementlock-pin');
      this.errorEl = overlay.querySelector('.movementlock-error');

      overlay.querySelector('.movementlock-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const pin = this.pinInputEl.value;
        const ok = await this._tryUnlock(pin);
        if (!ok) {
          this.errorEl.hidden = false;
          this.pinInputEl.value = '';
          this.pinInputEl.focus();
        }
      });

      // Bloquea teclado global (Tab, Alt, F5, etc.) mientras está activo el overlay,
      // salvo dentro del propio formulario de desbloqueo.
      document.addEventListener(
        'keydown',
        (e) => {
          if (!this.locked) return;
          if (overlay.contains(e.target)) return;
          e.preventDefault();
          e.stopPropagation();
        },
        true
      );

      document.addEventListener('contextmenu', (e) => {
        if (this.locked) e.preventDefault();
      });
    }

    _showOverlay() {
      this.overlayEl.classList.add('is-visible');
      this.errorEl.hidden = true;
      document.body.style.overflow = 'hidden';
      setTimeout(() => this.pinInputEl.focus(), 0);
    }

    _hideOverlay() {
      this.overlayEl.classList.remove('is-visible');
      document.body.style.overflow = '';
    }
  }

  global.MovementLock = MovementLock;
  global.MovementLockUtils = { sha256Hex, haversineMeters };
})(window);
