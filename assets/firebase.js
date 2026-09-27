/* ==========================================================================
   CYBERQUEST — Operation ECLIPSE Command Center
   firebase.js — Integración con Firebase (Web SDK modular, vía CDN)

   Este archivo es un módulo ES nativo (import/export), cargado por el
   navegador directamente desde la CDN de Firebase (gstatic). No requiere
   Node.js, npm ni bundlers: funciona igual en Apache HTTP simple que en
   HTTPS, sirviendo los archivos estáticos tal cual.

   Expone un API mínimo (autenticación + progreso en Realtime Database) que
   consume assets/app.js. Las contraseñas nunca pasan por aquí como texto
   gestionado por nosotros: Firebase Authentication las maneja por completo.
   ========================================================================== */

import {
  initializeApp
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';

import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  updateProfile,
  GoogleAuthProvider,
  signInWithPopup
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';

import {
  getDatabase,
  ref,
  get,
  set,
  update,
  serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';

var firebaseConfig = {
  apiKey: "AIzaSyCeJnPxEo-IvKfJgExv0OZSBInn60xQXN0",
  authDomain: "cyberquest-eclipse.firebaseapp.com",
  databaseURL: "https://cyberquest-eclipse-default-rtdb.firebaseio.com",
  projectId: "cyberquest-eclipse",
  storageBucket: "cyberquest-eclipse.firebasestorage.app",
  messagingSenderId: "527435954885",
  appId: "1:527435954885:web:2b70dc7cb93bbc4c9b4eac"
};

var app = initializeApp(firebaseConfig);
var auth = getAuth(app);
var db = getDatabase(app);
var googleProvider = new GoogleAuthProvider();

/* ------------------------------------------------------------------------
   Mensajes de error en español (nunca se muestra el error crudo de Firebase)
   ------------------------------------------------------------------------ */
export function mapFirebaseError(error) {
  var code = (error && error.code) || '';
  switch (code) {
    case 'auth/invalid-email':
      return 'El correo electrónico no es válido.';
    case 'auth/user-not-found':
      return 'No existe una cuenta con ese correo electrónico.';
    case 'auth/wrong-password':
      return 'Contraseña incorrecta.';
    case 'auth/invalid-credential':
    case 'auth/invalid-login-credentials':
      return 'Correo o contraseña incorrectos.';
    case 'auth/email-already-in-use':
      return 'Ese correo electrónico ya está registrado.';
    case 'auth/weak-password':
      return 'La contraseña es demasiado débil (mínimo 6 caracteres).';
    case 'auth/too-many-requests':
      return 'Demasiados intentos. Espera un momento antes de volver a intentarlo.';
    case 'auth/network-request-failed':
      return 'Problema de conexión. Verifica tu red e intenta de nuevo.';
    case 'auth/user-disabled':
      return 'Esta cuenta ha sido deshabilitada.';
    case 'auth/popup-closed-by-user':
      return 'Se cerró la ventana de Google antes de completar el inicio de sesión.';
    case 'auth/cancelled-popup-request':
      return 'Se canceló la solicitud anterior. Intenta iniciar sesión con Google de nuevo.';
    case 'auth/popup-blocked':
      return 'El navegador bloqueó la ventana emergente de Google. Habilita las ventanas emergentes para este sitio e intenta de nuevo.';
    default:
      if (code.indexOf('auth/') === 0) return 'No se pudo completar la operación de autenticación. Intenta de nuevo.';
      return 'Error guardando progreso. Verifica tu conexión e intenta de nuevo.';
  }
}

/* ------------------------------------------------------------------------
   Autenticación
   ------------------------------------------------------------------------ */

// Crea la cuenta en Firebase Auth y el perfil/progreso inicial en RTDB.
export function registerAccount(name, email, password) {
  return createUserWithEmailAndPassword(auth, email, password).then(function (credential) {
    var user = credential.user;
    return updateProfile(user, { displayName: name }).then(function () {
      return set(ref(db, 'users/' + user.uid + '/profile'), {
        name: name,
        email: email,
        createdAt: serverTimestamp()
      });
    }).then(function () {
      return set(ref(db, 'users/' + user.uid + '/progress'), {
        score: 0,
        completedStages: [],
        badges: [],
        currentMission: 1,
        completed: false,
        updatedAt: serverTimestamp()
      });
    }).then(function () {
      return user;
    });
  });
}

export function loginAccount(email, password) {
  return signInWithEmailAndPassword(auth, email, password).then(function (credential) {
    return credential.user;
  });
}

export function logoutAccount() {
  return signOut(auth);
}

// Abre el popup de Google, autentica al usuario y, solo si es su primera
// vez (no existe perfil todavía), crea profile/progress iniciales. Si el
// usuario ya existe, su progreso NUNCA se sobrescribe.
export function loginWithGoogle() {
  return signInWithPopup(auth, googleProvider).then(function (credential) {
    var user = credential.user;
    return get(ref(db, 'users/' + user.uid + '/profile')).then(function (snap) {
      if (snap.exists()) return user; // ya existe: no tocar su progreso

      return set(ref(db, 'users/' + user.uid + '/profile'), {
        name: user.displayName || '',
        email: user.email || '',
        createdAt: serverTimestamp()
      }).then(function () {
        return set(ref(db, 'users/' + user.uid + '/progress'), {
          score: 0,
          completedStages: [],
          badges: [],
          currentMission: 1,
          completed: false,
          updatedAt: serverTimestamp()
        });
      }).then(function () {
        return user;
      });
    });
  });
}

// callback(user|null) — se dispara al cargar y en cada cambio de sesión.
export function onAuthChange(callback) {
  return onAuthStateChanged(auth, callback);
}

/* ------------------------------------------------------------------------
   Perfil y progreso (Realtime Database, users/{uid})
   ------------------------------------------------------------------------ */

export function fetchProfile(uid) {
  return get(ref(db, 'users/' + uid + '/profile')).then(function (snap) {
    return snap.exists() ? snap.val() : null;
  });
}

export function fetchProgress(uid) {
  return get(ref(db, 'users/' + uid + '/progress')).then(function (snap) {
    return snap.exists() ? snap.val() : null;
  });
}

// progress: { score, completedStages(array), badges(array), currentMission, completed }
export function saveProgress(uid, progress) {
  var payload = {
    score: progress.score,
    completedStages: progress.completedStages,
    badges: progress.badges,
    currentMission: progress.currentMission,
    completed: progress.completed,
    updatedAt: serverTimestamp()
  };
  return update(ref(db, 'users/' + uid + '/progress'), payload);
}

export function resetProgress(uid) {
  return set(ref(db, 'users/' + uid + '/progress'), {
    score: 0,
    completedStages: [],
    badges: [],
    currentMission: 1,
    completed: false,
    updatedAt: serverTimestamp()
  });
}
