/* ==========================================================================
   CYBERQUEST — Operation ECLIPSE Command Center
   app.js — Lógica de la aplicación (JavaScript vanilla, sin dependencias,
   cargado como módulo ES nativo para poder importar assets/firebase.js)

   Índice:
     1. SHA-256 (implementación propia, sin Web Crypto / sin Internet)
     2. Datos de la operación (personajes, misiones, etapas, insignias)
     3. Persistencia de estado (localStorage, respaldo local)
     4. Lógica de progreso (score, desbloqueos, finalización)
     5. Sincronización con Firebase (cuentas + progreso por usuario)
     6. Renderizado de UI
     7. Manejo de eventos (incluye autenticación)
     8. Inicialización
   ========================================================================== */

import * as CQFirebase from './firebase.js';

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
          desc: 'HELIX-SRV01 (192.168.56.105) generó un beacon saliente anómalo hacia un host externo desconocido, fuera del horario habitual de operación. El registro de captura incluye un campo de identificación de servicio sin decodificar.',
          objective: 'Reconstruir la enumeración inicial del incidente decodificando el identificador de servicio capturado en el log de red.',
          technique: 'Reconocimiento y enumeración de servicios · Codificación Base64',
          evidence: 'capture.log (HELIX-SRV01):\n[03:12:41] outbound beacon detected -> host externo no autorizado\nservice-id (base64): RkxBR3tTSUdOQUxfR0hPU1RfSURFTlRJRklFRH0=',
          techData: [
            ['Archivo de evidencia', 'capture.log'],
            ['Campo a analizar', 'service-id'],
            ['Codificación detectada', 'Base64']
          ],
          hash: '1575bd1c92a3d398dffc596f95f32c1e879bb1215866bfcb3bad5de374b4b286',
          hint: 'El campo "service-id" no está en texto plano. Identifica en qué codificación está representado y aplica el proceso inverso para obtener el identificador real de la señal.',
          interpretation: 'Se detectó una señal saliente anómala desde HELIX-SRV01. Al decodificar el identificador en Base64 se confirmó que correspondía a la señal inicial asociada con Operación ECLIPSE.'
        },
        {
          id: 2,
          title: 'Compromised Credentials',
          desc: 'Los registros de autenticación SSH de HELIX-SRV01 (192.168.56.105) muestran decenas de intentos fallidos contra la cuenta voss, seguidos de un acceso exitoso. Una auditoría de políticas de contraseña reveló el patrón estructural usado para generarla.',
          objective: 'Reconstruir el ataque contra el servicio SSH (puerto 22) y confirmar cómo la cuenta voss fue comprometida a partir de una contraseña predecible.',
          technique: 'Generación de candidatos · Ataque de diccionario dirigido contra SSH',
          evidence: 'auth.log (HELIX-SRV01 · 192.168.56.105):\nsshd: Failed password for voss from 10.0.4.17 port 51101 ssh2\nsshd: Failed password for voss from 10.0.4.17 port 51102 ssh2\n... (47 intentos fallidos registrados)\nsshd: Accepted password for voss from 10.0.4.17 port 51122 ssh2\n\npassword_policy_audit.txt:\nCuenta voss - patrón de contraseña detectado: 3 letras minúsculas + 3 dígitos (formato tipo "abc123")',
          techData: [
            ['Servidor', 'HELIX-SRV01 (192.168.56.105)'],
            ['Servicio', 'SSH'],
            ['Puerto', '22'],
            ['Usuario objetivo', 'voss'],
            ['Patrón de contraseña', '3 letras minúsculas + 3 números (ej. abc123)'],
            ['Evidencia a recuperar tras el acceso', 'mission2.txt', true]
          ],
          hash: 'f5f50977bdd639d5895baf9fb478626534c056532cd2f17ef2da0d3e2e0f26d4',
          hint: 'El patrón de la contraseña reduce enormemente el espacio de búsqueda. Piensa cómo generar sistemáticamente todas las combinaciones de 3 letras minúsculas seguidas de 3 números, y qué herramienta de auditoría te permitiría probarlas contra el servicio SSH en el puerto 22.',
          hint2: 'No necesitas un diccionario externo. El patrón de contraseña permite generar una lista de candidatos de forma controlada.',
          interpretation: 'Los registros muestran múltiples intentos fallidos de autenticación SSH contra la cuenta voss en HELIX-SRV01, seguidos de un acceso exitoso. La contraseña, generada a partir de un patrón predecible (3 letras minúsculas + 3 números), fue comprometida mediante un ataque de diccionario dirigido, confirmando la debilidad de la credencial.'
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
          desc: 'En el directorio de comunicaciones de Elena Torres se localizó un archivo codificado (comms_elena.b64) con indicios de manipulación durante su tránsito. Un manifiesto de integridad acompaña al archivo.',
          objective: 'Verificar la integridad del archivo contra el hash publicado en su manifiesto y, solo si coincide, decodificar su contenido en Base64.',
          technique: 'Verificación de integridad SHA-256 · Decodificación Base64',
          evidence: 'Directorio de Elena (/home/elena/comms/):\n- comms_elena.b64 (contenido codificado a recuperar)\n- manifest.json:\n  { "file": "comms_elena.b64", "sha256_expected": "(leer valor real del archivo manifest.json)" }\n\nProcedimiento: abre manifest.json y toma el valor real del campo sha256_expected; luego calcula el SHA-256 de comms_elena.b64 y compara ambos valores.',
          techData: [
            ['Archivo a verificar', 'comms_elena.b64'],
            ['Hash esperado', 'campo sha256_expected en manifest.json'],
            ['Paso siguiente', 'decodificar contenido Base64 tras validar integridad']
          ],
          hash: '59c2232c667a0bb991f1c6907ac8848fad0c616bb15fe9335c7076eff87dc020',
          hint: 'Antes de decodificar nada, calcula el SHA-256 de comms_elena.b64 y compáralo con el valor sha256_expected del manifiesto. Si coinciden, el contenido no fue alterado y puedes proceder a decodificarlo.',
          interpretation: 'El archivo de Elena fue recuperado al decodificar su contenido Base64. Antes de eso, el SHA-256 calculado coincidió con el valor esperado en el manifiesto, confirmando que la comunicación recuperada mantenía su integridad.'
        },
        {
          id: 4,
          title: 'Marcus File',
          desc: 'La cuenta marcus ejecutó una exportación de datos fuera de su ventana habitual de mantenimiento. Existen varios registros que deben cruzarse para determinar si la operación fue autorizada.',
          objective: 'Correlacionar el log de exportación con los registros de tickets y de ventanas de mantenimiento para determinar si la exportación tuvo autorización.',
          technique: 'Correlación de logs, CSV y registros de exportación',
          evidence: 'export.log:\n2026-09-21 03:14:02 user=marcus action=EXPORT target=research_db size=1.2GB\n\nticketing_system.csv:\nticket_id,user,resource,status,scheduled_time\nTCK-4410,marcus,research_db,CLOSED,2026-09-18 10:00\nTCK-4423,elena,comms_share,APPROVED,2026-09-22 09:00\n\nmaintenance_window.csv:\nwindow_id,resource,start,end\nMW-118,research_db,2026-09-20 22:00,2026-09-21 01:00\nMW-119,research_db,2026-09-24 22:00,2026-09-25 01:00',
          techData: [
            ['Registros a correlacionar', 'export.log, ticketing_system.csv, maintenance_window.csv'],
            ['Cuenta investigada', 'marcus'],
            ['Recurso exportado', 'research_db']
          ],
          hash: '690df1c81e7ba7ab5d3e1657b76daf4ee86152f14b8d210f6035acde71eacde1',
          hint: 'Cruza los tres registros: ¿quién ejecutó la acción, sobre qué recurso, y existe un ticket o una ventana de mantenimiento que la respalde?',
          interpretation: 'Los registros muestran que la cuenta marcus ejecutó una exportación del recurso research_db y no existe un ticket de aprobación ni una ventana de mantenimiento asociada. Por ello se concluye que la exportación fue no autorizada.'
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
          desc: 'Una captura de tráfico (capture.pcap) registró una sesión TCP sostenida desde HELIX-SRV01 hacia una IP externa, justo después de la exportación no autorizada.',
          objective: 'Analizar capture.pcap para reconstruir el flujo TCP/SSH y confirmar el destino real de la transferencia.',
          technique: 'Análisis de PCAP con Wireshark · Reensamblado de flujos TCP/SSH',
          evidence: 'capture.pcap (resumen de streams):\nstream[12] 192.168.56.105:51330 -> destination: <identificar en el stream>:22 (SSH)\nbytes=884213\nsession-id: <recuperar del flujo TCP>\ntraffic-status: EXTERNAL_TRANSFER_DETECTED',
          techData: [
            ['Archivo a analizar', 'capture.pcap'],
            ['Origen', '192.168.56.105 (HELIX-SRV01)'],
            ['Puerto de interés', '22/TCP (SSH)'],
            ['Identificador de sesión', 'buscar en el stream reconstruido']
          ],
          hash: '851d106c9601c81b7ec6ed444a70bc4da80bcc2a2be17cd77f3ced1fdb9ce7a6',
          hint: 'Filtra el tráfico por la IP de HELIX-SRV01 y el puerto SSH. Sigue (follow) el flujo TCP correspondiente para identificar la IP de destino y el identificador de sesión.',
          interpretation: 'El análisis del PCAP muestra tráfico SSH entre HELIX-SRV01 y una dirección externa. La correlación de IP, puerto y sesión confirma una transferencia de datos fuera del entorno autorizado.'
        },
        {
          id: 6,
          title: 'The Hidden Package',
          desc: 'El paquete exfiltrado incluía una imagen (capture.jpg) con contenido oculto embebido mediante esteganografía. Ese contenido se relaciona con un archivo cifrado (payload.enc) encontrado junto a ella.',
          objective: 'Extraer el contenido oculto de la imagen y usarlo para descifrar payload.enc (AES-256-CBC, clave derivada con PBKDF2).',
          technique: 'Extracción esteganográfica · Descifrado AES-256-CBC · Derivación de clave PBKDF2',
          evidence: 'Archivos recuperados junto al paquete exfiltrado:\n- capture.jpg (contiene datos ocultos embebidos)\n- payload.enc (cifrado con AES-256-CBC, derivación PBKDF2)',
          techData: [
            ['Imagen con datos ocultos', 'capture.jpg'],
            ['Archivo cifrado', 'payload.enc'],
            ['Esquema de cifrado', 'AES-256-CBC + PBKDF2']
          ],
          hash: '8f038c9aa13ba93673902f42cebececabe2952e856e7ec8cd4306a649376307c',
          hint: 'Primero extrae el contenido oculto de la imagen. Lo que encuentres ahí es justo lo que necesitas para descifrar payload.enc.',
          hint2: 'El artefacto fue protegido usando el identificador legado: helix06.',
          interpretation: 'Se recuperó información oculta mediante esteganografía. Esa información permitió obtener la clave necesaria para descifrar el archivo protegido con AES-256-CBC, revelando la existencia de un nodo auxiliar.'
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
          desc: 'Los metadatos del sistema de archivos en HELIX-SRV01 muestran inconsistencias en la unidad /etc/systemd/system/eclipse-monitor.service: su timestamp de modificación es anterior al de creación.',
          objective: 'Comparar las referencias temporales del archivo para detectar la manipulación anti-forense de metadatos (timestomping).',
          technique: 'Forense digital · Análisis de timestamps MACB',
          evidence: 'fls -m / disk.img (extracto):\n/etc/systemd/system/eclipse-monitor.service\nM: 2025-01-03  A: 2026-09-20  C: 2026-09-20  B: 2026-09-20\n-> anomalía: M anterior a B',
          techData: [
            ['Archivo a inspeccionar', '/etc/systemd/system/eclipse-monitor.service'],
            ['Referencia 1', 'M (Modificación) = 2025-01-03'],
            ['Referencia 2', 'B (Birth / creación) = 2026-09-20']
          ],
          hash: 'a13587a3fed3906b854b849d63d0705389efd9fbf961483a0bb2bd67eac73497',
          hint: 'Compara la referencia M (modificación) con la referencia B (creación) del mismo archivo. Si un archivo aparece "modificado" antes de haber sido "creado", hay manipulación de metadatos.',
          interpretation: 'La comparación de timestamps evidenció inconsistencias en la secuencia temporal del archivo, demostrando que una marca de tiempo había sido modificada para ocultar actividad.'
        },
        {
          id: 8,
          title: 'The Persistent Service',
          desc: 'Se identificó una unidad systemd, eclipse-monitor.service, ejecutando un script con privilegios elevados. El script cuenta con una firma digital que debe validarse contra una clave pública.',
          objective: 'Localizar el script asociado al servicio y verificar su firma digital para determinar si el binario en ejecución corresponde al original.',
          technique: 'Unidades systemd y persistencia · Verificación de firma digital RSA',
          evidence: 'systemctl cat eclipse-monitor.service:\nExecStart=/usr/local/bin/eclipse-monitor.sh\n\nArchivos relacionados en /etc/eclipse-monitor/:\n- pubkey.pem (clave pública)\n- eclipse-monitor.sig (firma del script original)\n\nResultado posible de verificación:\nVerified OK          (script sin modificar)\nVerification failure  (script alterado)',
          techData: [
            ['Servicio', 'eclipse-monitor.service'],
            ['Script asociado', '/usr/local/bin/eclipse-monitor.sh'],
            ['Clave pública / firma', '/etc/eclipse-monitor/pubkey.pem y eclipse-monitor.sig']
          ],
          hash: '17bea0dd9cf7e4b0ca366698f8efc6a82948811f86ffadf6f340db566860543f',
          hint: 'Localiza el script que ejecuta el servicio y busca en su directorio de configuración la clave pública y la firma asociadas. Verifica si el script actual corresponde a la firma original.',
          interpretation: 'Se identificó un servicio systemd persistente. La firma RSA permitió comprobar la integridad del script original y detectar modificaciones no autorizadas, confirmando el mecanismo de persistencia.'
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
          desc: 'La configuración del servicio persistente (eclipse-monitor.conf) contiene una etiqueta de propietario (owner_tag) ofuscada con un cifrado clásico por desplazamiento. El log de auditoría señala dónde buscar.',
          objective: 'Revisar el log de auditoría y el archivo de configuración cifrado, y romper el cifrado por desplazamiento para revelar la identidad detrás del servicio.',
          technique: 'Análisis de logs de auditoría · Criptoanálisis de cifrado César · Lógica en Python',
          evidence: "audit.log:\n[AUDIT] eclipse-monitor.conf modificado por proceso desconocido\n\neclipse-monitor.conf:\nowner_tag = 'ZLYCPJL VDULY THYJBZ'",
          techData: [
            ['Log a revisar', 'audit.log'],
            ['Archivo cifrado', 'eclipse-monitor.conf (campo owner_tag)'],
            ['Tipo de cifrado', 'desplazamiento clásico (César)']
          ],
          hash: '392f4c6a39a53fbc9d0e56d0b8c8a51001f7b5a75ce9d3147e45eb67b1e48771',
          hint: 'Un cifrado César solo tiene 25 desplazamientos posibles. Prueba sistemáticamente cada uno (por ejemplo con un pequeño script en Python) hasta obtener una palabra legible.',
          interpretation: 'El análisis del log de auditoría condujo al archivo de configuración cifrado. Al romper el cifrado César se recuperó la identidad del propietario del servicio, relacionando técnicamente la persistencia con la cuenta de Marcus Vale.'
        },
        {
          id: 10,
          title: 'Final Chain of Evidence',
          desc: 'Para cerrar formalmente Operation ECLIPSE, toda la evidencia recuperada debe compilarse y verificarse contra un manifiesto final de cadena de custodia.',
          objective: 'Verificar el hash SHA-256 del manifiesto final y confirmar que las evidencias listadas mantienen su integridad antes del cierre.',
          technique: 'Manifiesto de evidencia · Verificación SHA-256 · Cadena de custodia',
          evidence: 'final_manifest.json:\n{ "case": "OPERATION_ECLIPSE", "evidence_items": 4, "responsible": "marcus" }\n\nsha256sum final_manifest.json -> comparar contra el valor publicado',
          techData: [
            ['Manifiesto a usar', 'final_manifest.json'],
            ['Evidencias a verificar', 'las 4 evidencias listadas en el manifiesto'],
            ['Hash esperado', 'consultar el valor SHA-256 publicado junto al manifiesto final'],
            ['Objetivo', 'validar integridad SHA-256 antes de cerrar el caso']
          ],
          hash: 'bc6d0926c96e1cf4d86c72638a6502739e686e6f699377188afc99ea8f258943',
          hint: 'Calcula el SHA-256 del manifiesto final y compáralo con el valor publicado. Si coincide, todas las evidencias listadas mantienen su integridad y el caso puede cerrarse.',
          interpretation: 'El manifiesto SHA-256 permitió verificar la integridad de la cadena final de evidencias. Todos los archivos fueron validados correctamente, permitiendo cerrar formalmente Operación ECLIPSE.'
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

  function getCurrentMissionId() {
    var next = MISSIONS.filter(function (m) { return !isMissionComplete(m); })[0];
    return next ? next.id : MISSIONS[MISSIONS.length - 1].id;
  }

  /* ------------------------------------------------------------------------
     5. Sincronización con Firebase
     --------------------------------------------------------------------
     El progreso remoto (users/{uid}/progress) es la fuente de verdad tras
     iniciar sesión. localStorage se mantiene solo como respaldo local: se
     sigue escribiendo en cada avance, pero nunca se usa para sobrescribir
     progreso remoto igual o mayor (ver migrateLocalProgressIfNeeded).
     ------------------------------------------------------------------------ */

  var currentUser = null;

  // Convierte el estado interno (mapa de booleanos) al formato que se
  // guarda en Realtime Database.
  function progressPayloadFromState() {
    var completedStages = Object.keys(state.completedStages)
      .filter(function (id) { return state.completedStages[id]; })
      .map(function (id) { return parseInt(id, 10); });
    var badges = MISSIONS.filter(isMissionComplete).map(function (m) { return m.badge; });
    var score = getScore();
    return {
      score: score,
      completedStages: completedStages,
      badges: badges,
      currentMission: getCurrentMissionId(),
      completed: score >= TOTAL_POINTS
    };
  }

  // Aplica un objeto de progreso remoto (o recién migrado) al estado interno.
  function applyProgressToState(progress) {
    state = defaultState();
    var solvedIds = (progress && progress.completedStages) || [];
    solvedIds.forEach(function (id) {
      state.completedStages[id] = true;
    });
    state.finalScreenShown = !!(progress && progress.completed);
    saveState();
  }

  function persistProgressToFirebase() {
    if (!currentUser) return;
    var payload = progressPayloadFromState();
    CQFirebase.saveProgress(currentUser.uid, payload).catch(function () {
      showToast('Error guardando progreso en el servidor. Se mantuvo una copia local.', 'error');
    });
  }

  // Si el usuario ya tenía progreso en este navegador (localStorage) antes
  // de tener cuenta, y su progreso remoto sigue en cero, se le pregunta UNA
  // sola vez si quiere importarlo. Nunca se sobrescribe progreso remoto
  // mayor o igual con progreso local menor.
  function migrateLocalProgressIfNeeded(uid, remoteProgress) {
    var migrationKey = 'cyberquest_migration_prompted_' + uid;
    if (localStorage.getItem(migrationKey)) return Promise.resolve();

    var localRaw;
    try {
      localRaw = localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      localRaw = null;
    }
    if (!localRaw) {
      localStorage.setItem(migrationKey, '1');
      return Promise.resolve();
    }

    var localParsed;
    try {
      localParsed = JSON.parse(localRaw);
    } catch (e) {
      localParsed = null;
    }
    localStorage.setItem(migrationKey, '1'); // se pregunta una sola vez, se acepte o no

    if (!localParsed || !localParsed.completedStages) return Promise.resolve();

    var localSolvedCount = 0;
    MISSIONS.forEach(function (m) {
      m.stages.forEach(function (s) {
        if (localParsed.completedStages[s.id]) localSolvedCount++;
      });
    });
    var localScore = localSolvedCount * POINTS_PER_STAGE;
    var remoteScore = (remoteProgress && remoteProgress.score) || 0;

    if (localScore <= 0 || localScore <= remoteScore) {
      return Promise.resolve(); // nada que importar, o lo remoto ya es igual o mejor
    }

    var wantsImport = window.confirm(
      'Se detectó progreso guardado localmente en este navegador (' + localScore + ' / ' + TOTAL_POINTS + ' PTS).\n' +
      '¿Deseas importarlo a tu cuenta?'
    );
    if (!wantsImport) return Promise.resolve();

    var tempCompleted = {};
    MISSIONS.forEach(function (m) {
      m.stages.forEach(function (s) {
        tempCompleted[s.id] = !!localParsed.completedStages[s.id];
      });
    });
    var solvedIds = Object.keys(tempCompleted)
      .filter(function (id) { return tempCompleted[id]; })
      .map(function (id) { return parseInt(id, 10); });
    var badges = MISSIONS.filter(function (m) {
      return m.stages.every(function (s) { return tempCompleted[s.id]; });
    }).map(function (m) { return m.badge; });
    var nextMission = MISSIONS.filter(function (m) {
      return !m.stages.every(function (s) { return tempCompleted[s.id]; });
    })[0];

    var payload = {
      score: localScore,
      completedStages: solvedIds,
      badges: badges,
      currentMission: nextMission ? nextMission.id : MISSIONS[MISSIONS.length - 1].id,
      completed: localScore >= TOTAL_POINTS
    };

    return CQFirebase.saveProgress(uid, payload).catch(function () {
      showToast('No se pudo importar tu progreso local. Intenta de nuevo más tarde.', 'error');
    });
  }

  /* ------------------------------------------------------------------------
     6. Renderizado de UI
     ------------------------------------------------------------------------ */

  var el = {}; // cache de referencias DOM, se llena en initDomRefs()

  function initDomRefs() {
    el.authScreen = document.getElementById('auth-screen');
    el.authError = document.getElementById('auth-error');
    el.btnGoogleLogin = document.getElementById('btn-google-login');
    el.loginForm = document.getElementById('login-form');
    el.loginEmail = document.getElementById('login-email');
    el.loginPassword = document.getElementById('login-password');
    el.btnLogin = document.getElementById('btn-login');
    el.registerForm = document.getElementById('register-form');
    el.registerName = document.getElementById('register-name');
    el.registerEmail = document.getElementById('register-email');
    el.registerPassword = document.getElementById('register-password');
    el.registerPasswordConfirm = document.getElementById('register-password-confirm');
    el.btnRegister = document.getElementById('btn-register');
    el.linkShowRegister = document.getElementById('link-show-register');
    el.linkShowLogin = document.getElementById('link-show-login');

    el.bootScreen = document.getElementById('boot-screen');
    el.app = document.getElementById('app');
    el.btnEnterOperation = document.getElementById('btn-enter-operation');
    el.btnReset = document.getElementById('btn-reset');
    el.btnLogout = document.getElementById('btn-logout');
    el.topbarUserName = document.getElementById('topbar-user-name');

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

  // Bloque opcional "DATOS TÉCNICOS": únicamente los parámetros necesarios
  // para resolver la etapa (usuario, servicio, puerto, archivo, patrón...),
  // nunca comandos completos ni la solución.
  function renderTechData(stage) {
    if (!stage.techData || !stage.techData.length) return '';
    var rows = stage.techData.map(function (pair) {
      var isFullWidth = pair[2] === true;
      return '<div class="stage-tech-item' + (isFullWidth ? ' stage-tech-item--full' : '') + '">' +
        '<span class="stage-tech-key">' + escapeHtml(pair[0]) + '</span>' +
        '<span class="stage-tech-val">' + escapeHtml(pair[1]) + '</span>' +
        '</div>';
    }).join('');
    return '<div class="stage-field">' +
      '<span class="stage-field-label">Datos técnicos</span>' +
      '<div class="stage-tech-grid">' + rows + '</div>' +
      '</div>';
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

      renderTechData(stage) +

      '<div class="stage-hint-row">' +
        '<button class="btn btn-ghost btn-small stage-hint-btn" type="button">VER PISTA</button>' +
      '</div>' +
      '<div class="stage-hint-box hidden">' + escapeHtml(stage.hint + (stage.hint2 ? '\n\n' + stage.hint2 : '')) + '</div>' +

      '<div class="stage-flag-row">' +
        '<input type="text" class="stage-flag-input" placeholder="FLAG{...}" ' + (solved ? 'disabled' : '') + ' autocomplete="off" spellcheck="false">' +
        '<button class="btn btn-primary btn-small stage-submit-btn" ' + (solved ? 'disabled' : '') + '>VALIDAR</button>' +
      '</div>' +
      '<div class="stage-feedback"></div>' +
      '<div class="stage-interpretation hidden">' +
        '<span class="stage-interpretation-label">Interpretación del hallazgo</span>' +
        '<div class="stage-interpretation-text">' + escapeHtml(stage.interpretation) + '</div>' +
      '</div>';

    var input = wrapper.querySelector('.stage-flag-input');
    var button = wrapper.querySelector('.stage-submit-btn');
    var feedback = wrapper.querySelector('.stage-feedback');
    var hintBtn = wrapper.querySelector('.stage-hint-btn');
    var hintBox = wrapper.querySelector('.stage-hint-box');
    var interpretation = wrapper.querySelector('.stage-interpretation');

    hintBtn.addEventListener('click', function () {
      var isHidden = hintBox.classList.contains('hidden');
      hintBox.classList.toggle('hidden');
      hintBtn.textContent = isHidden ? 'OCULTAR PISTA' : 'VER PISTA';
    });

    if (solved) {
      input.value = '••••••••••••••••••••';
      feedback.textContent = 'Flag validada. Evidencia incorporada a la cadena de custodia.';
      feedback.className = 'stage-feedback ok';
      interpretation.classList.remove('hidden');
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
        interpretation.classList.remove('hidden');
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

    // 1. UI ya actualizada arriba. 2. Sincroniza con Firebase. 3. localStorage
    // ya quedó actualizado como respaldo (saveState() más arriba).
    persistProgressToFirebase();

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
      '¿Reiniciar todo el progreso de Operation ECLIPSE?\nEsta acción borrará el puntaje, las etapas resueltas y las insignias guardadas en tu cuenta y en este equipo.'
    );
    if (!confirmed) return;
    state = defaultState();
    saveState();
    closeMissionModal();
    hideFinalScreen();
    renderAll();
    showToast('Progreso reiniciado.', 'error');

    if (currentUser) {
      CQFirebase.resetProgress(currentUser.uid).catch(function () {
        showToast('Error guardando progreso: no se pudo reiniciar en el servidor.', 'error');
      });
    }
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

  function bootDoneKey(uid) {
    return 'cyberquest_bootdone_' + uid;
  }

  function enterOperation() {
    el.bootScreen.classList.add('hidden');
    el.app.classList.remove('hidden');
    if (currentUser) {
      try { localStorage.setItem(bootDoneKey(currentUser.uid), '1'); } catch (e) { /* ignorar */ }
    }
  }

  /* ------------------------------------------------------------------------
     7. Manejo de eventos (incluye autenticación)
     ------------------------------------------------------------------------ */

  function showAuthError(message) {
    el.authError.textContent = message;
    el.authError.classList.remove('hidden');
  }

  function clearAuthError() {
    el.authError.textContent = '';
    el.authError.classList.add('hidden');
  }

  function setAuthBusy(busy) {
    el.btnLogin.disabled = busy;
    el.btnRegister.disabled = busy;
    el.btnGoogleLogin.disabled = busy;
  }

  function showLoginForm() {
    clearAuthError();
    el.registerForm.classList.add('hidden');
    el.linkShowLogin.classList.add('hidden');
    el.loginForm.classList.remove('hidden');
    el.linkShowRegister.classList.remove('hidden');
  }

  function showRegisterForm() {
    clearAuthError();
    el.loginForm.classList.add('hidden');
    el.linkShowRegister.classList.add('hidden');
    el.registerForm.classList.remove('hidden');
    el.linkShowLogin.classList.remove('hidden');
  }

  function handleLoginSubmit(ev) {
    ev.preventDefault();
    clearAuthError();
    var email = el.loginEmail.value.trim();
    var password = el.loginPassword.value;
    if (!email || !password) {
      showAuthError('Completa todos los campos.');
      return;
    }
    setAuthBusy(true);
    CQFirebase.loginAccount(email, password)
      .catch(function (err) { showAuthError(CQFirebase.mapFirebaseError(err)); })
      .then(function () { setAuthBusy(false); });
  }

  function handleRegisterSubmit(ev) {
    ev.preventDefault();
    clearAuthError();
    var name = el.registerName.value.trim();
    var email = el.registerEmail.value.trim();
    var password = el.registerPassword.value;
    var confirmPassword = el.registerPasswordConfirm.value;

    if (!name || !email || !password || !confirmPassword) {
      showAuthError('Completa todos los campos.');
      return;
    }
    if (password !== confirmPassword) {
      showAuthError('Las contraseñas no coinciden.');
      return;
    }

    setAuthBusy(true);
    CQFirebase.registerAccount(name, email, password)
      .catch(function (err) { showAuthError(CQFirebase.mapFirebaseError(err)); })
      .then(function () { setAuthBusy(false); });
  }

  function handleGoogleLogin() {
    clearAuthError();
    setAuthBusy(true);
    CQFirebase.loginWithGoogle()
      .catch(function (err) { showAuthError(CQFirebase.mapFirebaseError(err)); })
      .then(function () { setAuthBusy(false); });
  }

  function handleLogout() {
    CQFirebase.logoutAccount().catch(function () {
      showToast('No se pudo cerrar sesión. Intenta de nuevo.', 'error');
    });
  }

  // Se dispara al cargar la página y en cada cambio de sesión (login/logout).
  function handleAuthChange(user) {
    if (user) {
      currentUser = user;
      el.authScreen.classList.add('hidden');

      CQFirebase.fetchProfile(user.uid)
        .then(function (profile) {
          el.topbarUserName.textContent = (profile && profile.name) || user.displayName || (user.email ? user.email.split('@')[0] : 'Analista');
          return CQFirebase.fetchProgress(user.uid);
        })
        .then(function (remoteProgress) {
          if (!remoteProgress) {
            // Cuenta recién creada o perfil sin nodo de progreso todavía:
            // inicializa el árbol en 0 (misma forma que crea registerAccount).
            return CQFirebase.resetProgress(user.uid).then(function () {
              return { score: 0, completedStages: [], badges: [], currentMission: 1, completed: false };
            });
          }
          return remoteProgress;
        })
        .then(function (remoteProgress) {
          return migrateLocalProgressIfNeeded(user.uid, remoteProgress).then(function () {
            return CQFirebase.fetchProgress(user.uid);
          });
        })
        .then(function (finalProgress) {
          applyProgressToState(finalProgress || { score: 0, completedStages: [], badges: [], currentMission: 1, completed: false });
          renderAll();

          var alreadyBooted = false;
          try { alreadyBooted = localStorage.getItem(bootDoneKey(user.uid)) === '1'; } catch (e) { /* ignorar */ }
          if (alreadyBooted) {
            el.bootScreen.classList.add('hidden');
            el.app.classList.remove('hidden');
          } else {
            el.bootScreen.classList.remove('hidden');
            el.app.classList.add('hidden');
          }
        })
        .catch(function () {
          showToast('No se pudo cargar tu progreso. Intenta recargar la página.', 'error');
        });
    } else {
      currentUser = null;
      state = defaultState();
      el.app.classList.add('hidden');
      el.bootScreen.classList.add('hidden');
      el.loginEmail.value = '';
      el.loginPassword.value = '';
      el.registerName.value = '';
      el.registerEmail.value = '';
      el.registerPassword.value = '';
      el.registerPasswordConfirm.value = '';
      showLoginForm();
      el.authScreen.classList.remove('hidden');
    }
  }

  function bindEvents() {
    el.btnGoogleLogin.addEventListener('click', handleGoogleLogin);
    el.loginForm.addEventListener('submit', handleLoginSubmit);
    el.registerForm.addEventListener('submit', handleRegisterSubmit);
    el.linkShowRegister.addEventListener('click', function (ev) { ev.preventDefault(); showRegisterForm(); });
    el.linkShowLogin.addEventListener('click', function (ev) { ev.preventDefault(); showLoginForm(); });

    el.btnEnterOperation.addEventListener('click', enterOperation);
    el.btnReset.addEventListener('click', handleReset);
    el.btnLogout.addEventListener('click', handleLogout);
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
     8. Inicialización
     ------------------------------------------------------------------------ */

  function init() {
    initDomRefs();
    bindEvents();
    showLoginForm();
    CQFirebase.onAuthChange(handleAuthChange);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
