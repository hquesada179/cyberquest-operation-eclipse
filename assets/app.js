/* ==========================================================================
   CYBERQUEST — Operation ECLIPSE Command Center
   app.js — Lógica de la aplicación (JavaScript vanilla, sin dependencias)

   Índice:
     1. SHA-256 (implementación propia, sin Web Crypto / sin Internet)
     2. Datos de la operación (personajes, misiones, etapas, insignias)
     3. Persistencia de estado (localStorage)
     4. Lógica de progreso (score, desbloqueos, finalización)
     5. Renderizado de UI
     6. Manejo de eventos
     7. Inicialización
   ========================================================================== */

(function () {
  'use strict';

  /* ------------------------------------------------------------------------
     1. SHA-256 (implementación propia)
     --------------------------------------------------------------------
     Las flags NUNCA se almacenan como texto plano en este archivo. En su
     lugar, cada etapa guarda el hash SHA-256 de su flag correcta. Cuando el
     usuario envía una respuesta, se calcula el SHA-256 de su texto (en
     mayúsculas y sin espacios sobrantes) y se compara contra el hash
     esperado. Esto evita exponer las flags directamente en el código fuente,
     aunque -como toda validación del lado del cliente- no sustituye un
     control de seguridad real en servidor.

     No se usa `crypto.subtle` porque requiere un "secure context" (HTTPS o
     localhost). Como esta aplicación se despliega típicamente sobre HTTP
     simple en un servidor Apache de laboratorio, se implementa el algoritmo
     manualmente para que funcione en cualquier contexto, sin conexión a
     Internet y sin dependencias externas.
     ------------------------------------------------------------------------ */

  function sha256(asciiLikeString) {
    function rightRotate(value, amount) {
      return (value >>> amount) | (value << (32 - amount));
    }

    var mathPow = Math.pow;
    var maxWord = mathPow(2, 32);
    var lengthProperty = 'length';
    var i, j;
    var result = '';

    var words = [];
    var asciiBitLength = asciiLikeString[lengthProperty] * 8;

    var hash = sha256.h = sha256.h || [];
    var k = sha256.k = sha256.k || [];
    var primeCounter = k[lengthProperty];

    var isComposite = {};
    for (var candidate = 2; primeCounter < 64; candidate++) {
      if (!isComposite[candidate]) {
        for (i = 0; i < 313; i += candidate) {
          isComposite[i] = candidate;
        }
        hash[primeCounter] = (mathPow(candidate, 0.5) * maxWord) | 0;
        k[primeCounter++] = (mathPow(candidate, 1 / 3) * maxWord) | 0;
      }
    }

    asciiLikeString += '\x80';
    while (asciiLikeString[lengthProperty] % 64 - 56) asciiLikeString += '\x00';
    for (i = 0; i < asciiLikeString[lengthProperty]; i++) {
      j = asciiLikeString.charCodeAt(i);
      if (j >> 8) return null; // byte fuera de rango, no debería ocurrir tras utf8Binary()
      words[i >> 2] |= j << ((3 - i) % 4) * 8;
    }
    words[words[lengthProperty]] = ((asciiBitLength / maxWord) | 0);
    words[words[lengthProperty]] = (asciiBitLength);

    for (j = 0; j < words[lengthProperty];) {
      var w = words.slice(j, j += 16);
      var oldHash = hash;
      hash = hash.slice(0, 8);

      for (i = 0; i < 64; i++) {
        var w15 = w[i - 15], w2 = w[i - 2];
        var a = hash[0], e = hash[4];

        var temp1 = hash[7]
          + (rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25))
          + ((e & hash[5]) ^ ((~e) & hash[6]))
          + k[i]
          + (w[i] = (i < 16) ? w[i] : (
              w[i - 16]
              + (rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3))
              + w[i - 7]
              + (rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10))
            ) | 0
          );
        var temp2 = (rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22))
          + ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2]));

        hash = [(temp1 + temp2) | 0].concat(hash);
        hash[4] = (hash[4] + temp1) | 0;
      }

      for (i = 0; i < 8; i++) {
        hash[i] = (hash[i] + oldHash[i]) | 0;
      }
    }

    for (i = 0; i < 8; i++) {
      for (j = 3; j + 1; j--) {
        var b = (hash[i] >> (j * 8)) & 255;
        result += ((b < 16) ? '0' : '') + b.toString(16);
      }
    }
    return result;
  }

  // Convierte un string UTF-8 arbitrario a una "cadena binaria" (1 char = 1 byte)
  function utf8Binary(str) {
    return unescape(encodeURIComponent(str));
  }

  // API pública usada por el resto de la app: hash hexadecimal de un texto
  function sha256Hex(str) {
    sha256.h = null;
    sha256.k = null;
    return sha256(utf8Binary(str));
  }

  // Normaliza la entrada del usuario antes de hashear: quita espacios en los
  // extremos y colapsa mayúsculas/minúsculas (todas las flags son en mayúsculas).
  function normalizeFlagInput(raw) {
    return String(raw || '').trim().toUpperCase();
  }

  /* ------------------------------------------------------------------------
     2. Datos de la operación
     ------------------------------------------------------------------------ */

  var CHARACTERS = [
    {
      role: 'DIRECTOR CIENTÍFICO',
      name: 'Dr. Adrian Voss',
      account: 'voss',
      bio: 'Responsable de Project ECLIPSE. Autorizó la activación del equipo CYBERQUEST tras detectar tráfico saliente no autorizado desde HELIX-SRV01.'
    },
    {
      role: 'ANALISTA DE OPERACIONES Y COMUNICACIONES',
      name: 'Elena Torres',
      account: 'elena',
      bio: 'Gestiona las comunicaciones internas del proyecto. Uno de sus archivos cifrados resultó clave para reconstruir la línea de tiempo del incidente.'
    },
    {
      role: 'ADMINISTRADOR DE INFRAESTRUCTURA',
      name: 'Marcus Vale',
      account: 'marcus',
      bio: 'Mantiene HELIX-SRV01 y sus servicios. Su cuenta administrativa aparece repetidamente en los registros de exportación y persistencia bajo investigación.'
    }
  ];

  // Cada etapa: id, título, descripción, objetivo, técnica, evidencia y el
  // HASH SHA-256 de su flag (nunca la flag en texto plano).
  var MISSIONS = [
    {
      id: 1,
      title: 'Signal Acquisition',
      badge: 'SPECTER TRACKER',
      stages: [
        {
          id: 1,
          title: 'The Ghost Signal',
          desc: 'Un beacon anómalo salió de HELIX-SRV01 hacia un host externo desconocido fuera del horario habitual de operación.',
          objective: 'Reconstruir la enumeración inicial del servicio y decodificar el identificador de la señal capturada.',
          technique: 'Reconocimiento y enumeración de servicios · Codificación Base64',
          evidence: 'capture.log:\n[srv01] outbound beacon detected\nservice-id (base64): RkxBR3tTSUdOQUxfR0hPU1RfSURFTlRJRklFRH0=',
          hash: '1575bd1c92a3d398dffc596f95f32c1e879bb1215866bfcb3bad5de374b4b286'
        },
        {
          id: 2,
          title: 'Compromised Credentials',
          desc: 'Los registros de autenticación SSH de HELIX-SRV01 muestran intentos repetidos seguidos de un login exitoso.',
          objective: 'Reconstruir el ataque de fuerza bruta y confirmar qué cuenta fue comprometida por una contraseña débil.',
          technique: 'Ataque de diccionario (Hydra) · Autenticación SSH',
          evidence: 'auth.log:\nsshd[victim]: 47 failed password attempts (dictionary pattern)\nsshd[victim]: Accepted password for svc-legacy from 10.0.4.17 port 51122 ssh2',
          hash: 'f5f50977bdd639d5895baf9fb478626534c056532cd2f17ef2da0d3e2e0f26d4'
        }
      ]
    },
    {
      id: 2,
      title: 'Internal Evidence',
      badge: 'ARCHIVE GUARDIAN',
      stages: [
        {
          id: 3,
          title: "Elena's File",
          desc: 'Se encontró un archivo codificado en el directorio de Elena Torres, con indicios de manipulación durante su tránsito.',
          objective: 'Decodificar el contenido en Base64 y verificar su integridad contra el checksum SHA-256 publicado en el manifiesto.',
          technique: 'Decodificación Base64 · Verificación de integridad SHA-256',
          evidence: 'manifest.json:\n{ "file": "comms_elena.b64", "sha256_expected": "match" }\nintegrity check: PASSED -> contenido recuperado',
          hash: '59c2232c667a0bb991f1c6907ac8848fad0c616bb15fe9335c7076eff87dc020'
        },
        {
          id: 4,
          title: 'Marcus File',
          desc: 'Los registros de exportación muestran que la cuenta de Marcus Vale generó una exportación de datos fuera de su ventana habitual de mantenimiento.',
          objective: 'Correlacionar metadatos de archivo y registros de exportación para determinar si la operación fue autorizada.',
          technique: 'Análisis de archivos, logs y exportaciones',
          evidence: 'export.log:\n2026-09-21 03:14:02 user=marcus action=EXPORT target=research_db size=1.2GB\napproval_ticket: NOT_FOUND',
          hash: '690df1c81e7ba7ab5d3e1657b76daf4ee86152f14b8d210f6035acde71eacde1'
        }
      ]
    },
    {
      id: 3,
      title: 'Exfiltration Trace',
      badge: 'SIGNAL HUNTER',
      stages: [
        {
          id: 5,
          title: 'Transfer Destination',
          desc: 'Una captura de tráfico (PCAP) registró una sesión TCP/SSH sostenida hacia una IP externa, justo después de la exportación no autorizada.',
          objective: 'Analizar la captura para reconstruir el flujo TCP/SSH y confirmar el destino real de la transferencia.',
          technique: 'Análisis de PCAP con Wireshark · Reensamblado de flujos TCP/SSH',
          evidence: 'capture.pcap (resumen):\nstream[12] 10.0.4.17:51330 -> 203.0.113.44:22 (SSH) bytes=884213\nfollow-tcp-stream -> payload marker: FLAG{ECLIPSE_DATA_EXFILTRATED}',
          hash: '851d106c9601c81b7ec6ed444a70bc4da80bcc2a2be17cd77f3ced1fdb9ce7a6'
        },
        {
          id: 6,
          title: 'The Hidden Package',
          desc: 'El paquete exfiltrado incluía una imagen con un archivo oculto embebido mediante esteganografía, protegido con contraseña.',
          objective: 'Extraer el contenedor oculto y descifrarlo (AES-256-CBC, clave derivada con PBKDF2) para revelar su contenido.',
          technique: 'Extracción esteganográfica (Steghide) · Descifrado AES-256-CBC · Derivación de clave PBKDF2',
          evidence: 'steghide --extract -sf capture.jpg\nopenssl enc -d -aes-256-cbc -pbkdf2 -in payload.enc\n-> archivo_auxiliar_node.txt recuperado',
          hash: '8f038c9aa13ba93673902f42cebececabe2952e856e7ec8cd4306a649376307c'
        }
      ]
    },
    {
      id: 4,
      title: 'Persistence Hunt',
      badge: 'HELIX SENTINEL',
      stages: [
        {
          id: 7,
          title: 'Altered Timestamp',
          desc: 'Los metadatos del sistema de archivos en HELIX-SRV01 muestran inconsistencias: timestamps de modificación anteriores a los de creación.',
          objective: 'Realizar un análisis forense de línea de tiempo (MACB) y detectar la manipulación anti-forense de metadatos.',
          technique: 'Forense digital · Análisis de timestamps y metadatos',
          evidence: 'fls -m / disk.img (extracto):\n/etc/systemd/system/helix-sync.service\nM: 2025-01-03  A: 2026-09-20  C: 2026-09-20  B: 2026-09-20\n-> anomalía: M anterior a B (timestomping)',
          hash: 'a13587a3fed3906b854b849d63d0705389efd9fbf961483a0bb2bd67eac73497'
        },
        {
          id: 8,
          title: 'The Persistent Service',
          desc: 'Se identificó una unidad systemd ejecutándose con privilegios elevados, validando su binario mediante una firma RSA.',
          objective: 'Identificar el mecanismo de persistencia y verificar la firma digital RSA asociada al binario.',
          technique: 'Unidades systemd y persistencia · Verificación de firma digital RSA',
          evidence: 'systemctl cat helix-sync.service\nExecStart=/usr/local/bin/helix-syncd --daemon\nopenssl dgst -sha256 -verify pubkey.pem -signature helix-syncd.sig helix-syncd\nVerified OK',
          hash: '17bea0dd9cf7e4b0ca366698f8efc6a82948811f86ffadf6f340db566860543f'
        }
      ]
    },
    {
      id: 5,
      title: 'Attribution & Closure',
      badge: 'ECLIPSE ARCHITECT',
      stages: [
        {
          id: 9,
          title: 'Identity Behind the Service',
          desc: 'La configuración del servicio persistente contiene una etiqueta de propietario ofuscada con un cifrado César.',
          objective: 'Trazar la lógica de decodificación (Python) y romper el cifrado César para revelar la identidad detrás del servicio.',
          technique: 'Análisis de logs · Criptoanálisis de cifrado César · Lógica en Python',
          evidence: "helix-sync.conf:\nowner_tag = 'PDUFXV'  # shift=3\n\npython3 -c \"print(''.join(chr((ord(c)-65-3)%26+65) for c in 'PDUFXV'))\"\n-> MARCUS",
          hash: '392f4c6a39a53fbc9d0e56d0b8c8a51001f7b5a75ce9d3147e45eb67b1e48771'
        },
        {
          id: 10,
          title: 'Final Chain of Evidence',
          desc: 'Para cerrar formalmente Operation ECLIPSE, toda la evidencia recuperada debe compilarse en un manifiesto de cadena de custodia verificable.',
          objective: 'Ensamblar el manifiesto final y verificar su hash SHA-256 para cerrar la investigación y confirmar la atribución.',
          technique: 'Manifiesto de evidencia · Hash SHA-256 · Cadena de custodia',
          evidence: 'final_manifest.json:\n{ "case": "OPERATION_ECLIPSE", "evidence_items": 10, "responsible": "marcus" }\nsha256sum final_manifest.json -> sealed & verified',
          hash: 'bc6d0926c96e1cf4d86c72638a6502739e686e6f699377188afc99ea8f258943'
        }
      ]
    }
  ];

  var TOTAL_STAGES = MISSIONS.reduce(function (acc, m) { return acc + m.stages.length; }, 0);
  var POINTS_PER_STAGE = 500;
  var TOTAL_POINTS = TOTAL_STAGES * POINTS_PER_STAGE;

  /* ------------------------------------------------------------------------
     3. Persistencia de estado (localStorage)
     ------------------------------------------------------------------------ */

  var STORAGE_KEY = 'cyberquest_eclipse_state_v1';

  function defaultState() {
    var completedStages = {};
    MISSIONS.forEach(function (m) {
      m.stages.forEach(function (s) { completedStages[s.id] = false; });
    });
    return {
      completedStages: completedStages,
      finalScreenShown: false,
      bootDone: false
    };
  }

  var state = loadState();

  function loadState() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultState();
      var parsed = JSON.parse(raw);
      var fresh = defaultState();
      // Fusiona con valores por defecto para tolerar versiones futuras
      if (parsed && typeof parsed === 'object') {
        if (parsed.completedStages) {
          Object.keys(fresh.completedStages).forEach(function (id) {
            fresh.completedStages[id] = !!parsed.completedStages[id];
          });
        }
        fresh.finalScreenShown = !!parsed.finalScreenShown;
        fresh.bootDone = !!parsed.bootDone;
      }
      return fresh;
    } catch (e) {
      return defaultState();
    }
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      // localStorage no disponible (modo privado estricto, cuota, etc.)
      console.warn('CYBERQUEST: no se pudo guardar el progreso en localStorage.', e);
    }
  }

  /* ------------------------------------------------------------------------
     4. Lógica de progreso
     ------------------------------------------------------------------------ */

  function getScore() {
    var completed = 0;
    Object.keys(state.completedStages).forEach(function (id) {
      if (state.completedStages[id]) completed++;
    });
    return completed * POINTS_PER_STAGE;
  }

  function getCompletedStagesCount() {
    return getScore() / POINTS_PER_STAGE;
  }

  function isStageSolved(stageId) {
    return !!state.completedStages[stageId];
  }

  function isMissionComplete(mission) {
    return mission.stages.every(function (s) { return isStageSolved(s.id); });
  }

  function getCompletedMissionsCount() {
    return MISSIONS.filter(isMissionComplete).length;
  }

  function isMissionUnlocked(mission) {
    var index = MISSIONS.indexOf(mission);
    if (index === 0) return true;
    return isMissionComplete(MISSIONS[index - 1]);
  }

  function getUnlockedBadgesCount() {
    return getCompletedMissionsCount();
  }

  // Devuelve true si la flag enviada es correcta para la etapa dada
  function checkFlag(stage, rawInput) {
    var normalized = normalizeFlagInput(rawInput);
    if (!normalized) return false;
    var hash = sha256Hex(normalized);
    return hash === stage.hash;
  }

  /* ------------------------------------------------------------------------
     5. Renderizado de UI
     ------------------------------------------------------------------------ */

  var el = {}; // cache de referencias DOM, se llena en initDomRefs()

  function initDomRefs() {
    el.bootScreen = document.getElementById('boot-screen');
    el.app = document.getElementById('app');
    el.btnEnterOperation = document.getElementById('btn-enter-operation');
    el.btnReset = document.getElementById('btn-reset');

    el.topbarScoreValue = document.getElementById('topbar-score-value');
    el.operationStatus = document.getElementById('operation-status');
    el.progressBarFill = document.getElementById('progress-bar-fill');
    el.progressLabelValue = document.getElementById('progress-label-value');

    el.statMissions = document.getElementById('stat-missions');
    el.statStages = document.getElementById('stat-stages');
    el.statBadges = document.getElementById('stat-badges');

    el.missionsGrid = document.getElementById('missions-grid');
    el.badgesGrid = document.getElementById('badges-grid');
    el.charactersGrid = document.getElementById('characters-grid');

    el.missionModal = document.getElementById('mission-modal');
    el.modalMissionLabel = document.getElementById('modal-mission-label');
    el.modalMissionTitle = document.getElementById('modal-mission-title');
    el.modalBody = document.getElementById('modal-body');
    el.btnCloseModal = document.getElementById('btn-close-modal');

    el.finalScreen = document.getElementById('final-screen');
    el.btnCloseFinal = document.getElementById('btn-close-final');

    el.toastStack = document.getElementById('toast-stack');
  }

  function renderDashboard() {
    var score = getScore();
    var missionsDone = getCompletedMissionsCount();
    var stagesDone = getCompletedStagesCount();
    var badgesDone = getUnlockedBadgesCount();
    var pct = Math.round((score / TOTAL_POINTS) * 100);

    el.topbarScoreValue.textContent = score + ' / ' + TOTAL_POINTS;
    el.progressLabelValue.textContent = score + ' / ' + TOTAL_POINTS + ' PTS';
    el.progressBarFill.style.width = pct + '%';

    el.statMissions.textContent = missionsDone + ' / ' + MISSIONS.length;
    el.statStages.textContent = stagesDone + ' / ' + TOTAL_STAGES;
    el.statBadges.textContent = badgesDone + ' / ' + MISSIONS.length;

    if (score >= TOTAL_POINTS) {
      el.operationStatus.textContent = 'OPERACIÓN COMPLETADA';
      el.operationStatus.classList.remove('status-active');
      el.operationStatus.classList.add('status-complete');
    } else {
      el.operationStatus.textContent = 'OPERACIÓN ACTIVA';
      el.operationStatus.classList.remove('status-complete');
      el.operationStatus.classList.add('status-active');
    }
  }

  function renderMissions() {
    el.missionsGrid.innerHTML = '';
    MISSIONS.forEach(function (mission) {
      var unlocked = isMissionUnlocked(mission);
      var complete = isMissionComplete(mission);
      var solvedCount = mission.stages.filter(function (s) { return isStageSolved(s.id); }).length;
      var pct = Math.round((solvedCount / mission.stages.length) * 100);

      var card = document.createElement('div');
      card.className = 'mission-card' + (unlocked ? '' : ' mission-locked') + (complete ? ' mission-complete' : '');
      card.setAttribute('data-mission-id', mission.id);

      var statusIcon = complete ? '<span class="mission-card-check" title="Completada">✓</span>'
        : (unlocked ? '' : '<span class="mission-card-lock" title="Bloqueada">🔒</span>');

      card.innerHTML =
        '<div class="mission-card-top">' +
          '<span class="mission-card-id">MISIÓN ' + mission.id + '</span>' +
          statusIcon +
        '</div>' +
        '<div class="mission-card-title">' + escapeHtml(mission.title) + '</div>' +
        '<div class="mission-card-badge">🎖 ' + escapeHtml(mission.badge) + '</div>' +
        '<div class="mission-card-progress"><div class="mission-card-progress-fill" style="width:' + pct + '%"></div></div>' +
        '<span class="mission-card-stages-label">' + solvedCount + ' / ' + mission.stages.length + ' etapas · 1000 pts</span>';

      card.addEventListener('click', function () {
        if (!unlocked) {
          showToast('Misión bloqueada. Completa la misión anterior primero.', 'error');
          return;
        }
        openMissionModal(mission.id);
      });

      el.missionsGrid.appendChild(card);
    });
  }

  function renderBadges() {
    el.badgesGrid.innerHTML = '';
    MISSIONS.forEach(function (mission) {
      var unlocked = isMissionComplete(mission);
      var item = document.createElement('div');
      item.className = 'badge-item' + (unlocked ? ' badge-unlocked' : '');
      item.innerHTML =
        '<div class="badge-icon">' + (unlocked ? '🎖' : '🔒') + '</div>' +
        '<div>' +
          '<div class="badge-name">' + escapeHtml(mission.badge) + '</div>' +
          '<div class="badge-desc">Misión ' + mission.id + ' — ' + escapeHtml(mission.title) + '</div>' +
        '</div>';
      el.badgesGrid.appendChild(item);
    });
  }

  function renderCharacters() {
    el.charactersGrid.innerHTML = '';
    CHARACTERS.forEach(function (c) {
      var card = document.createElement('div');
      card.className = 'character-card';
      card.innerHTML =
        '<div class="character-role">' + escapeHtml(c.role) + '</div>' +
        '<div class="character-name">' + escapeHtml(c.name) + '</div>' +
        '<div class="character-account">cuenta: ' + escapeHtml(c.account) + '</div>' +
        '<div class="character-bio">' + escapeHtml(c.bio) + '</div>';
      el.charactersGrid.appendChild(card);
    });
  }

  function renderStageCard(stage) {
    var solved = isStageSolved(stage.id);
    var wrapper = document.createElement('div');
    wrapper.className = 'stage-card' + (solved ? ' stage-solved' : '');
    wrapper.setAttribute('data-stage-id', stage.id);

    wrapper.innerHTML =
      '<div class="stage-card-header">' +
        '<div>' +
          '<span class="stage-card-label">ETAPA ' + stage.id + '</span>' +
          '<h3 class="stage-card-title">' + escapeHtml(stage.title) + '</h3>' +
        '</div>' +
        '<span class="stage-status-pill' + (solved ? ' solved' : '') + '">' + (solved ? '✓ RESUELTA' : '500 PTS') + '</span>' +
      '</div>' +

      '<div class="stage-field">' +
        '<span class="stage-field-label">Descripción</span>' +
        '<div class="stage-field-value">' + escapeHtml(stage.desc) + '</div>' +
      '</div>' +

      '<div class="stage-field">' +
        '<span class="stage-field-label">Objetivo</span>' +
        '<div class="stage-field-value">' + escapeHtml(stage.objective) + '</div>' +
      '</div>' +

      '<div class="stage-field">' +
        '<span class="stage-field-label">Técnica principal</span>' +
        '<div class="stage-field-value">' + escapeHtml(stage.technique) + '</div>' +
      '</div>' +

      '<div class="stage-field">' +
        '<span class="stage-field-label">Evidencia relevante</span>' +
        '<div class="stage-field-value evidence">' + escapeHtml(stage.evidence) + '</div>' +
      '</div>' +

      '<div class="stage-flag-row">' +
        '<input type="text" class="stage-flag-input" placeholder="FLAG{...}" ' + (solved ? 'disabled' : '') + ' autocomplete="off" spellcheck="false">' +
        '<button class="btn btn-primary btn-small stage-submit-btn" ' + (solved ? 'disabled' : '') + '>VALIDAR</button>' +
      '</div>' +
      '<div class="stage-feedback"></div>';

    var input = wrapper.querySelector('.stage-flag-input');
    var button = wrapper.querySelector('.stage-submit-btn');
    var feedback = wrapper.querySelector('.stage-feedback');

    if (solved) {
      input.value = '••••••••••••••••••••';
      feedback.textContent = 'Flag validada. Evidencia incorporada a la cadena de custodia.';
      feedback.className = 'stage-feedback ok';
    }

    function attemptSubmit() {
      if (isStageSolved(stage.id)) return;
      var value = input.value;
      if (!value.trim()) {
        feedback.textContent = 'Ingresa una flag antes de validar.';
        feedback.className = 'stage-feedback err';
        return;
      }
      if (checkFlag(stage, value)) {
        onStageSolved(stage);
        feedback.textContent = 'Correcto. +500 PTS. Evidencia incorporada.';
        feedback.className = 'stage-feedback ok';
        input.value = '••••••••••••••••••••';
        input.disabled = true;
        button.disabled = true;
        wrapper.classList.add('stage-solved');
        var pill = wrapper.querySelector('.stage-status-pill');
        pill.textContent = '✓ RESUELTA';
        pill.classList.add('solved');
      } else {
        feedback.textContent = 'Flag incorrecta. Revisa la evidencia y vuelve a intentarlo.';
        feedback.className = 'stage-feedback err';
      }
    }

    button.addEventListener('click', attemptSubmit);
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') attemptSubmit();
    });

    return wrapper;
  }

  function renderMissionModalBody(mission) {
    el.modalMissionLabel.textContent = 'MISIÓN ' + mission.id + ' · ' + mission.badge;
    el.modalMissionTitle.textContent = mission.title;
    el.modalBody.innerHTML = '';
    mission.stages.forEach(function (stage) {
      el.modalBody.appendChild(renderStageCard(stage));
    });
  }

  function renderAll() {
    renderDashboard();
    renderMissions();
    renderBadges();
    renderCharacters();
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  /* ------------------------------------------------------------------------
     6. Manejo de eventos
     ------------------------------------------------------------------------ */

  var activeMissionId = null;

  function openMissionModal(missionId) {
    var mission = MISSIONS.filter(function (m) { return m.id === missionId; })[0];
    if (!mission) return;
    activeMissionId = missionId;
    renderMissionModalBody(mission);
    el.missionModal.classList.remove('hidden');
  }

  function closeMissionModal() {
    el.missionModal.classList.add('hidden');
    activeMissionId = null;
  }

  function onStageSolved(stage) {
    var wasAlreadySolved = isStageSolved(stage.id);
    if (wasAlreadySolved) return; // nunca sumar puntos dos veces por la misma etapa

    state.completedStages[stage.id] = true;
    saveState();

    renderDashboard();
    renderMissions();
    renderBadges();

    showToast('Etapa ' + stage.id + ' resuelta: +500 PTS', 'success');

    // ¿La misión activa quedó completa? -> insignia desbloqueada
    var mission = MISSIONS.filter(function (m) { return m.stages.indexOf(stage) !== -1; })[0];
    if (mission && isMissionComplete(mission)) {
      showToast('Insignia desbloqueada: ' + mission.badge, 'badge');
    }

    // ¿Se alcanzó el puntaje total? -> pantalla final
    if (getScore() >= TOTAL_POINTS) {
      setTimeout(showFinalScreen, 500);
    }
  }

  function showFinalScreen() {
    if (state.finalScreenShown) {
      // Aun así se puede mostrar de nuevo si el usuario reabre, pero no repetimos animación de toast
    }
    state.finalScreenShown = true;
    saveState();
    closeMissionModal();
    el.finalScreen.classList.remove('hidden');
  }

  function hideFinalScreen() {
    el.finalScreen.classList.add('hidden');
  }

  function handleReset() {
    var confirmed = window.confirm(
      '¿Reiniciar todo el progreso de Operation ECLIPSE?\nEsta acción borrará el puntaje, las etapas resueltas y las insignias guardadas en este equipo.'
    );
    if (!confirmed) return;
    state = defaultState();
    saveState();
    closeMissionModal();
    hideFinalScreen();
    renderAll();
    showToast('Progreso reiniciado.', 'error');
  }

  function showToast(message, type) {
    var toast = document.createElement('div');
    toast.className = 'toast' + (type ? ' toast-' + type : '');
    toast.textContent = message;
    el.toastStack.appendChild(toast);
    setTimeout(function () {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s ease';
      setTimeout(function () { toast.remove(); }, 300);
    }, 3200);
  }

  function enterOperation() {
    el.bootScreen.classList.add('hidden');
    el.app.classList.remove('hidden');
    state.bootDone = true;
    saveState();
  }

  function bindEvents() {
    el.btnEnterOperation.addEventListener('click', enterOperation);
    el.btnReset.addEventListener('click', handleReset);
    el.btnCloseModal.addEventListener('click', closeMissionModal);
    el.btnCloseFinal.addEventListener('click', hideFinalScreen);

    el.missionModal.addEventListener('click', function (ev) {
      if (ev.target === el.missionModal) closeMissionModal();
    });
    el.finalScreen.addEventListener('click', function (ev) {
      if (ev.target === el.finalScreen) hideFinalScreen();
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') {
        closeMissionModal();
        hideFinalScreen();
      }
    });
  }

  /* ------------------------------------------------------------------------
     7. Inicialización
     ------------------------------------------------------------------------ */

  function init() {
    initDomRefs();
    bindEvents();
    renderAll();

    // Si el usuario ya había entrado a la operación en una sesión previa,
    // salta directamente al dashboard en vez de mostrar el boot screen.
    if (state.bootDone) {
      el.bootScreen.classList.add('hidden');
      el.app.classList.remove('hidden');
    }

    // Si el progreso guardado ya estaba completo, ofrece ver el cierre.
    if (getScore() >= TOTAL_POINTS && state.finalScreenShown) {
      // No se auto-muestra en cada carga para no ser intrusivo;
      // el usuario puede revisar el dashboard, que ya refleja 5000/5000.
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
