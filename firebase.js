
import { initializeApp } from "https://www.gstatic.com/firebasejs/13.3.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/13.3.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/13.3.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyCr3nOug7ePX0JONfqur_ezyYYmGilqF20",
  authDomain: "attendease-b2c7a.firebaseapp.com",
  projectId: "attendease-b2c7a",
  storageBucket: "attendease-b2c7a.firebasestorage.app",
  messagingSenderId: "1035333368541",
  appId: "1:1035333368541:web:6547efb5c79977a5017934"
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);
