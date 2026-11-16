
import { auth, db } from "./firebase.js";

import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/13.3.0/firebase-auth.js";

import {
  doc,
  getDoc,
  setDoc,
  collection,
  getDocs,
  deleteDoc
} from "https://www.gstatic.com/firebasejs/13.3.0/firebase-firestore.js";

const STORAGE_KEY = "attendease_v2";
const LEGACY_STORAGE_KEY = "attendease_v1";
const SESSION_KEY = "attendease_session_v2";
const PASSWORD_ITERATIONS = 120000;
const $ = (id) => document.getElementById(id);

const today = new Date();

const localDate = (date) => {
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60000)
    .toISOString()
    .slice(0, 10);
};

let appData = loadAppData();
let currentTeacher = null;
let selectedClassId = null;
let selectedSectionId = null;
let activeReasonStudent = null;

let isCreatingAccount = false;

function loadAppData() {
  try {
    const saved = JSON.parse(
      localStorage.getItem(STORAGE_KEY) || "null"
    );

    if (
      saved &&
      Array.isArray(saved.teachers) &&
      Array.isArray(saved.classes) &&
      saved.records
    ) {
      return {
        teachers: saved.teachers,
        classes: saved.classes,
        records: saved.records,
        legacyImported: Boolean(saved.legacyImported)
      };
    }
  } catch (error) {
    console.warn("Could not read AttendEase data.", error);
  }

  return {
    teachers: [],
    classes: [],
    records: {},
    legacyImported: false
  };
}

let cloudSaveQueue = Promise.resolve();

function saveData() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(appData)
    );

    const user = auth.currentUser;

    if (!user || !currentTeacher) return true;

    const teacherId = user.uid;

    const teacherClasses = appData.classes.filter(
      item => item.teacherId === teacherId
    );

    const classIds = new Set(
      teacherClasses.map(item => item.id)
    );

    const teacherRecords = Object.fromEntries(
      Object.entries(appData.records).filter(([key]) =>
        classIds.has(key.split("|")[1])
      )
    );

    const cloudData = {
      name: currentTeacher.name,
      email: user.email,
      classes: teacherClasses,
      records: teacherRecords,
      legacyImported: Boolean(appData.legacyImported),
      updatedAt: new Date().toISOString()
    };

    cloudSaveQueue = cloudSaveQueue
      .catch(() => {})
      .then(async () => {
        await setDoc(
          doc(db, "teachers", teacherId, "appData", "state"),
          cloudData
        );
      });

    cloudSaveQueue.catch(error => {
      console.error("Firebase cloud save failed:", error);

      const savedMessage = $("savedMessage");

      if (savedMessage) {
        savedMessage.textContent =
          "Cloud sync failed. Please check your internet connection.";
      }
    });

    return true;

  } catch (error) {
    console.error("Could not save AttendEase data.", error);

    alert(
      "AttendEase could not save the information. Please try again."
    );

    return false;
  }
}

function makeId(prefix) {
  const randomPart = Math.random().toString(36).slice(2, 9);
  return `${prefix}_${Date.now().toString(36)}_${randomPart}`;
}

function escapeHTML(value) {
  return String(value).replace(
    /[&<>"']/g,
    ch => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[ch])
  );
}

function bytesToHex(bytes) {
  return Array.from(
    bytes,
    byte => byte.toString(16).padStart(2, "0")
  ).join("");
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);

  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = parseInt(
      hex.slice(index * 2, index * 2 + 2),
      16
    );
  }

  return bytes;
}

function createSalt() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return bytesToHex(bytes);
}

async function hashPassword(password, salt) {
  if (!window.crypto || !crypto.subtle) {
    throw new Error(
      "Secure browser tools are unavailable. Open AttendEase using VS Code Live Server or an HTTPS website."
    );
  }

  const encoder = new TextEncoder();

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );

  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: hexToBytes(salt),
      iterations: PASSWORD_ITERATIONS,
      hash: "SHA-256"
    },
    keyMaterial,
    256
  );

  return bytesToHex(new Uint8Array(bits));
}

function makeRecordKey(date, classId, sectionId, studentId) {
  return `${date}|${classId}|${sectionId}|${studentId}`;
}

function createClassForTeacher(
  teacherId,
  name,
  subject = "",
  level = "",
  sectionName = "Section A"
) {
  const newClass = {
    id: makeId("class"),
    teacherId,
    name,
    subject,
    level,
    sections: [
      {
        id: makeId("section"),
        name: sectionName,
        students: []
      }
    ]
  };

  appData.classes.push(newClass);
  return newClass;
}

function importStarterData(teacherId) {
  if (appData.legacyImported) return;

  let legacy = null;

  try {
    legacy = JSON.parse(
      localStorage.getItem(LEGACY_STORAGE_KEY) || "null"
    );
  } catch (error) {
    console.warn("The older AttendEase data could not be read.", error);
  }

  const starterClass = createClassForTeacher(
    teacherId,
    "My First Class",
    "",
    "",
    "Section A"
  );

  const starterSection = starterClass.sections[0];

  const oldStudents = Array.isArray(legacy?.students)
    ? legacy.students
    : [];

  oldStudents.forEach(student => {
    if (student && student.id && student.name) {
      starterSection.students.push({
        id: String(student.id),
        name: String(student.name)
      });
    }
  });

  if (
    legacy?.records &&
    typeof legacy.records === "object"
  ) {
    Object.entries(legacy.records).forEach(
      ([oldKey, record]) => {
        const splitAt = oldKey.indexOf("_");

        if (splitAt < 0) return;

        const date = oldKey.slice(0, splitAt);
        const studentId = oldKey.slice(splitAt + 1);

        if (!date || !studentId || !record) return;

        const newKey = makeRecordKey(
          date,
          starterClass.id,
          starterSection.id,
          studentId
        );

        appData.records[newKey] = record;
      }
    );
  }

  appData.legacyImported = true;
}

function getTeacherClasses() {
  if (!currentTeacher) return [];

  return appData.classes.filter(
    item => item.teacherId === currentTeacher.id
  );
}

function getSelectedClass() {
  return getTeacherClasses().find(
    item => item.id === selectedClassId
  ) || null;
}

function getSelectedSection() {
  const selectedClass = getSelectedClass();

  if (!selectedClass) return null;

  return selectedClass.sections.find(
    item => item.id === selectedSectionId
  ) || null;
}

function ensureSelection() {
  const classes = getTeacherClasses();

  if (!classes.some(item => item.id === selectedClassId)) {
    selectedClassId = classes.length
      ? classes[0].id
      : null;
  }

  const selectedClass = getSelectedClass();

  if (
    !selectedClass ||
    !selectedClass.sections.some(
      item => item.id === selectedSectionId
    )
  ) {
    selectedSectionId =
      selectedClass && selectedClass.sections.length
        ? selectedClass.sections[0].id
        : null;
  }
}

function getRecord(studentId) {
  const date = $("attendanceDate").value;

  const key = makeRecordKey(
    date,
    selectedClassId,
    selectedSectionId,
    studentId
  );

  return appData.records[key] || {
    status: "Unmarked",
    reason: "",
    notes: ""
  };
}

function setAuthMode(mode) {
  const isLogin = mode === "login";

  $("loginForm").hidden = !isLogin;
  $("registerForm").hidden = isLogin;

  $("showLoginBtn").classList.toggle("active", isLogin);
  $("showRegisterBtn").classList.toggle("active", !isLogin);

  $("authView").querySelector(".eyebrow").textContent = isLogin
    ? "Teacher sign in"
    : "Create your teacher account";

  $("authIntro").textContent = isLogin
    ? "Sign in to access your classes and attendance from any device."
    : "Create your teacher account to organize your classes and attendance.";

  $("authMessage").textContent = "";
  $("authMessage").classList.remove("success");
}

function showAuth(message = "") {
  currentTeacher = null;

  $("appView").hidden = true;
  $("authView").hidden = false;

  setAuthMode("login");
  $("authMessage").textContent = message;
}

function showApp() {
  if (!currentTeacher) return;

  $("authView").hidden = true;
  $("appView").hidden = false;

  $("todayLabel").textContent = today.toLocaleDateString(
    undefined,
    {
      weekday: "short",
      month: "long",
      day: "numeric",
      year: "numeric"
    }
  );

  $("attendanceDate").value = localDate(today);
  $("teacherLabel").textContent = currentTeacher.name;

  $("welcomeHeading").textContent =
    `Good day, ${currentTeacher.name}!`;

  ensureSelection();
  renderAll();
}

function renderClassSelectors() {
  ensureSelection();

  const classes = getTeacherClasses();

  $("classSelect").innerHTML = classes.map(item =>
    `<option value="${escapeHTML(item.id)}" ${
      item.id === selectedClassId ? "selected" : ""
    }>${escapeHTML(item.name)}</option>`
  ).join("");

  $("classSelect").disabled = classes.length === 0;

  const selectedClass = getSelectedClass();

  const sections = selectedClass
    ? selectedClass.sections
    : [];

  $("sectionSelect").innerHTML = sections.map(item =>
    `<option value="${escapeHTML(item.id)}" ${
      item.id === selectedSectionId ? "selected" : ""
    }>${escapeHTML(item.name)}</option>`
  ).join("");

  $("sectionSelect").disabled = sections.length === 0;

  $("addStudentBtn").disabled = !getSelectedSection();
  $("addSectionBtn").disabled = !selectedClass;
}

function renderClassManager() {
  const classes = getTeacherClasses();

  if (!classes.length) {
    $("classList").innerHTML =
      '<div class="empty-manager">You do not have a class yet. Use the form above to create one.</div>';

    return;
  }

  $("classList").innerHTML = classes.map(classItem => {
    const details = [
      classItem.subject,
      classItem.level
    ].filter(Boolean).join(" · ");

    const sections = classItem.sections.map(section => `
      <div class="section-item">
        <span>${escapeHTML(section.name)} · ${section.students.length} student(s)</span>
        <div class="manage-actions">
          <button
            class="small-button"
            type="button"
            data-action="rename-section"
            data-class-id="${escapeHTML(classItem.id)}"
            data-section-id="${escapeHTML(section.id)}"
          >Rename</button>

          <button
            class="small-button danger"
            type="button"
            data-action="delete-section"
            data-class-id="${escapeHTML(classItem.id)}"
            data-section-id="${escapeHTML(section.id)}"
            ${classItem.sections.length === 1
              ? 'disabled title="Keep at least one section in a class"'
              : ""}
          >Remove</button>
        </div>
      </div>
    `).join("");

    return `
      <article class="manage-card">
        <div class="manage-card-top">
          <div>
            <strong>${escapeHTML(classItem.name)}</strong>
            <p>${escapeHTML(details || "No subject or grade details")}</p>
          </div>

          <div class="manage-actions">
            <button
              class="small-button"
              type="button"
              data-action="rename-class"
              data-class-id="${escapeHTML(classItem.id)}"
            >Rename</button>

            <button
              class="small-button danger"
              type="button"
              data-action="delete-class"
              data-class-id="${escapeHTML(classItem.id)}"
              ${classes.length === 1
                ? 'disabled title="Keep at least one class"'
                : ""}
            >Remove</button>
          </div>
        </div>

        <div class="section-list">
          ${sections || '<p class="muted">No sections yet.</p>'}
        </div>
      </article>
    `;
  }).join("");
}

function renderStudents() {
  const section = getSelectedSection();

  const students = section
    ? section.students
    : [];

  const query = $("searchInput").value.trim().toLowerCase();
  const filter = $("statusFilter").value;

  const visible = students.filter(student => {
    const record = getRecord(student.id);

    const matchesText =
      student.name.toLowerCase().includes(query) ||
      student.id.toLowerCase().includes(query);

    const matchesStatus =
      filter === "All" || record.status === filter;

    return matchesText && matchesStatus;
  });

  $("studentRows").innerHTML = visible.map(student => {
    const record = getRecord(student.id);

    const reason = [
      record.reason,
      record.notes
    ].filter(Boolean).join(" — ");

    const needsReason =
      record.status === "Absent" ||
      record.status === "Late";

    return `
      <tr>
        <td>
          ${escapeHTML(student.name)}
          <span class="student-id">${escapeHTML(student.id)}</span>

          <div class="manage-actions student-actions">
            <button
              class="small-button"
              type="button"
              data-student-action="edit"
              data-student-id="${escapeHTML(student.id)}"
            >Edit</button>

            <button
              class="small-button danger"
              type="button"
              data-student-action="delete"
              data-student-id="${escapeHTML(student.id)}"
            >Delete</button>
          </div>
        </td>

        <td>
          <select
            class="status-select"
            data-status-id="${escapeHTML(student.id)}"
            aria-label="Attendance status for ${escapeHTML(student.name)}"
          >
            ${["Unmarked", "Present", "Absent", "Late"].map(status =>
              `<option ${
                record.status === status ? "selected" : ""
              } value="${status}">
                ${status === "Unmarked" ? "Not marked" : status}
              </option>`
            ).join("")}
          </select>
        </td>

        <td>
          <div class="reason-cell">
            <span
              class="reason-text"
              title="${escapeHTML(reason)}"
            >
              ${needsReason
                ? (reason ? escapeHTML(reason) : "No reason added")
                : "—"}
            </span>

            ${needsReason
              ? `<button
                  class="reason-button"
                  type="button"
                  data-reason-id="${escapeHTML(student.id)}"
                >${reason ? "Edit reason" : "＋ Add reason"}</button>`
              : ""}
          </div>
        </td>
      </tr>
    `;
  }).join("");

  $("emptyState").hidden = visible.length !== 0;

  if (!section) {
    $("emptyState").textContent =
      "Create a class and section to start adding students.";
  } else {
    $("emptyState").textContent = students.length
      ? "No students match your search or filter."
      : "No students in this section yet. Add a student to get started.";
  }

  const counts = students.reduce((acc, student) => {
    const status = getRecord(student.id).status;
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});

  $("totalCount").textContent = students.length;
  $("presentCount").textContent = counts.Present || 0;
  $("absentCount").textContent = counts.Absent || 0;
  $("lateCount").textContent = counts.Late || 0;

  const classItem = getSelectedClass();

  $("attendanceContext").textContent =
    classItem && section
      ? `${classItem.name} · ${section.name} — choose a status for every student.`
      : "Create a class and section before taking attendance.";
}


function exportAttendanceCSV() {
  const classItem = getSelectedClass();
  const section = getSelectedSection();
  const selectedDate = $("historyDateSelect").value;

  if (!classItem || !section || !selectedDate) {
    alert("No attendance records are available to export.");
    return;
  }

  const records = Object.entries(appData.records)
    .map(([key, record]) => ({
      parts: key.split("|"),
      record
    }))
    .filter(item =>
      item.parts[0] === selectedDate &&
      item.parts[1] === classItem.id &&
      item.parts[2] === section.id
    );

  if (!records.length) {
    alert("There are no attendance records for this date.");
    return;
  }

  function csvCell(value) {
    let text = String(value ?? "");

    // Help prevent spreadsheet formula execution.
    if (/^[=+\-@\t\r]/.test(text)) {
      text = "'" + text;
    }

    return `"${text.replace(/"/g, '""')}"`;
  }

  const rows = [
    [
      "Date",
      "Class",
      "Section",
      "Student Name",
      "Student ID",
      "Attendance Status",
      "Reason",
      "Notes"
    ]
  ];

  records.forEach(item => {
    const studentId = item.parts[3];

    const student = section.students.find(
      person => person.id === studentId
    );

    rows.push([
      selectedDate,
      classItem.name,
      section.name,
      student ? student.name : "Removed student",
      studentId,
      item.record.status || "Unmarked",
      item.record.reason || "",
      item.record.notes || ""
    ]);
  });

  const csvContent =
    "\uFEFF" +
    rows.map(row => row.map(csvCell).join(",")).join("\r\n");

  const blob = new Blob(
    [csvContent],
    { type: "text/csv;charset=utf-8;" }
  );

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download =
    `AttendEase_${selectedDate}_${classItem.name.replace(/[^a-z0-9]/gi, "_")}.csv`;

  document.body.appendChild(link);
  link.click();
  link.remove();

  URL.revokeObjectURL(url);

  alert("Attendance report exported successfully!");
}


function renderHistory() {
  const section = getSelectedSection();
  const classItem = getSelectedClass();

  const dateSelect = $("historyDateSelect");
  const historyRows = $("historyRows");
  const emptyState = $("historyEmptyState");

  if (!section || !classItem) {
    dateSelect.innerHTML = '<option value="">No records available</option>';
    historyRows.innerHTML = "";
    emptyState.hidden = false;
    emptyState.textContent = "Choose a class and section to view attendance history.";

    $("historyTotalCount").textContent = 0;
    $("historyPresentCount").textContent = 0;
    $("historyAbsentCount").textContent = 0;
    $("historyLateCount").textContent = 0;
    return;
  }

  const dates = [
    ...new Set(
      Object.keys(appData.records)
        .map(key => key.split("|"))
        .filter(parts =>
          parts[1] === classItem.id &&
          parts[2] === section.id
        )
        .map(parts => parts[0])
        .filter(Boolean)
    )
  ].sort((a, b) => b.localeCompare(a));

  if (!dates.length) {
    dateSelect.innerHTML = '<option value="">No records available</option>';
    historyRows.innerHTML = "";
    emptyState.hidden = false;
    emptyState.textContent = "No attendance history is available for this class and section yet.";

    $("historyTotalCount").textContent = 0;
    $("historyPresentCount").textContent = 0;
    $("historyAbsentCount").textContent = 0;
    $("historyLateCount").textContent = 0;
    return;
  }

  const previousDate = dateSelect.value;
  const selectedDate = dates.includes(previousDate)
    ? previousDate
    : dates[0];

  dateSelect.innerHTML = dates.map(date =>
    `<option value="${escapeHTML(date)}" ${
      date === selectedDate ? "selected" : ""
    }>${escapeHTML(date)}</option>`
  ).join("");

  const historyRecords = Object.entries(appData.records)
    .map(([key, record]) => ({
      parts: key.split("|"),
      record
    }))
    .filter(item =>
      item.parts[0] === selectedDate &&
      item.parts[1] === classItem.id &&
      item.parts[2] === section.id
    );

  const counts = {
    Present: 0,
    Absent: 0,
    Late: 0,
    Unmarked: 0
  };

  historyRecords.forEach(item => {
    const status = item.record.status || "Unmarked";
    counts[status] = (counts[status] || 0) + 1;
  });

  $("historyTotalCount").textContent = historyRecords.length;
  $("historyPresentCount").textContent = counts.Present;
  $("historyAbsentCount").textContent = counts.Absent;
  $("historyLateCount").textContent = counts.Late;

  historyRows.innerHTML = historyRecords.map(item => {
    const studentId = item.parts[3];

    const student = section.students.find(
      person => person.id === studentId
    );

    const studentName = student
      ? student.name
      : "Removed student";

    const record = item.record;
    const reason = [record.reason, record.notes]
      .filter(Boolean)
      .join(" — ");

    return `
      <tr>
        <td>${escapeHTML(studentName)}</td>
        <td>${escapeHTML(studentId)}</td>
        <td>${escapeHTML(record.status || "Unmarked")}</td>
        <td>${escapeHTML(reason || "—")}</td>
      </tr>
    `;
  }).join("");

  emptyState.hidden = historyRecords.length > 0;

  if (!historyRecords.length) {
    emptyState.textContent = "No attendance records were found for this date.";
  }
}

function renderAll() {
  renderClassSelectors();
  renderClassManager();
  renderStudents();
  renderHistory();
}


function openReasonDialog(studentId) {
  const section = getSelectedSection();

  if (!section) return;

  activeReasonStudent = studentId;

  const student = section.students.find(
    item => item.id === studentId
  );

  if (!student) return;

  const record = getRecord(studentId);

  $("reasonTitle").textContent = `${record.status} reason`;
  $("reasonStudent").textContent =
    `${student.name} · ${student.id}`;

  $("reasonSelect").value = record.reason || "";
  $("reasonNotes").value = record.notes || "";

  $("reasonDialog").showModal();
}

function removeRecordsForClass(classId, sectionId = null) {
  Object.keys(appData.records).forEach(key => {
    const parts = key.split("|");

    if (
      parts[1] === classId &&
      (!sectionId || parts[2] === sectionId)
    ) {
      delete appData.records[key];
    }
  });
}

// EDIT STUDENT
function editStudent(studentId) {
  const section = getSelectedSection();
  const classItem = getSelectedClass();

  if (!section || !classItem) return;

  const student = section.students.find(
    item => item.id === studentId
  );

  if (!student) return;

  const newName = prompt(
    "Enter the student's new name:",
    student.name
  );

  if (newName === null || !newName.trim()) return;

  const newId = prompt(
    "Enter the student's new ID:",
    student.id
  );

  if (newId === null || !newId.trim()) return;

  const cleanName = newName.trim();
  const cleanId = newId.trim();

  const duplicate = section.students.some(
    item =>
      item.id.toLowerCase() === cleanId.toLowerCase() &&
      item.id !== student.id
  );

  if (duplicate) {
    alert("That student ID already exists in this section.");
    return;
  }

  const oldId = student.id;

  student.name = cleanName;
  student.id = cleanId;

  if (oldId !== cleanId) {
    const updatedRecords = {};

    Object.entries(appData.records).forEach(([key, record]) => {
      const parts = key.split("|");

      if (
        parts[1] === classItem.id &&
        parts[2] === section.id &&
        parts[3] === oldId
      ) {
        parts[3] = cleanId;
        updatedRecords[parts.join("|")] = record;
      } else {
        updatedRecords[key] = record;
      }
    });

    appData.records = updatedRecords;
  }

  saveData();
  renderAll();

  alert("Student information updated successfully!");
}

// DELETE STUDENT
function deleteStudent(studentId) {
  const section = getSelectedSection();

  if (!section) return;

  const student = section.students.find(
    item => item.id === studentId
  );

  if (!student) return;

  const confirmed = confirm(
    `Are you sure you want to remove ${student.name} from this section? Their existing attendance records will be preserved.`
  );

  if (!confirmed) return;

  section.students = section.students.filter(
    item => item.id !== studentId
  );

  saveData();
  renderAll();

  alert("Student removed successfully.");
}

// AUTHENTICATION EVENTS

$("showLoginBtn").addEventListener("click", () => {
  setAuthMode("login");
});

$("showRegisterBtn").addEventListener("click", () => {
  setAuthMode("register");
});

// TEACHER REGISTRATION

$("registerForm").addEventListener("submit", async event => {
  event.preventDefault();

  const name = $("registerName").value.trim();
  const email = $("registerEmail").value.trim().toLowerCase();
  const password = $("registerPassword").value;
  const confirmPassword = $("confirmPassword").value;
  const message = $("authMessage");

  message.classList.remove("success");

  if (!name) {
    message.textContent = "Please enter your name.";
    return;
  }

  if (password.length < 8) {
    message.textContent =
      "Please use a password with at least 8 characters.";
    return;
  }

  if (password !== confirmPassword) {
    message.textContent =
      "The passwords do not match. Please try again.";
    return;
  }

  $("registerBtn").disabled = true;
  message.textContent = "Creating your Firebase account...";

  isCreatingAccount = true;

  try {
    const credential = await createUserWithEmailAndPassword(
      auth,
      email,
      password
    );

    const user = credential.user;

    currentTeacher = {
      id: user.uid,
      name: name,
      email: user.email
    };

    if (!appData.legacyImported) {
      importStarterData(user.uid);
    } else {
      createClassForTeacher(user.uid, "My First Class");
    }

    const teacherClasses = appData.classes.filter(
      item => item.teacherId === user.uid
    );

    const classIds = new Set(
      teacherClasses.map(item => item.id)
    );

    const teacherRecords = Object.fromEntries(
      Object.entries(appData.records).filter(([key]) =>
        classIds.has(key.split("|")[1])
      )
    );

    const cloudData = {
      name: name,
      email: user.email,
      classes: teacherClasses,
      records: teacherRecords,
      legacyImported: Boolean(appData.legacyImported),
      updatedAt: new Date().toISOString()
    };

    await setDoc(
      doc(db, "teachers", user.uid, "appData", "state"),
      cloudData
    );

    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(appData)
    );

    selectedClassId = null;
    selectedSectionId = null;

    showApp();
    $("registerForm").reset();

  } catch (error) {
    console.error("Registration error:", error);

    if (error.code === "auth/email-already-in-use") {
      message.textContent =
        "This email is already registered. Please log in.";
    } else if (error.code === "auth/invalid-email") {
      message.textContent =
        "Please enter a valid email address.";
    } else if (error.code === "auth/weak-password") {
      message.textContent =
        "Please choose a stronger password.";
    } else if (error.code === "permission-denied") {
      message.textContent =
        "Firebase permission denied. Please check your Firestore rules.";
    } else {
      message.textContent =
        error.message || "Account creation failed. Please try again.";
    }

  } finally {
    isCreatingAccount = false;
    $("registerBtn").disabled = false;
  }
});

// TEACHER LOGIN

$("loginForm").addEventListener("submit", async event => {
  event.preventDefault();

  const email = $("loginEmail").value.trim().toLowerCase();
  const password = $("loginPassword").value;
  const message = $("authMessage");

  message.classList.remove("success");
  $("loginBtn").disabled = true;

  message.textContent = "Signing in to Firebase...";

  try {
    const credential = await signInWithEmailAndPassword(
      auth,
      email,
      password
    );

    const user = credential.user;

    const stateRef = doc(
      db,
      "teachers",
      user.uid,
      "appData",
      "state"
    );

    const snapshot = await getDoc(stateRef);

    if (!snapshot.exists()) {
      throw new Error(
        "Your teacher data could not be found. Please contact your administrator."
      );
    }

    const cloudData = snapshot.data();

    appData.classes = appData.classes.filter(
      item => item.teacherId !== user.uid
    );

    const cloudClasses = cloudData.classes || [];
    appData.classes.push(...cloudClasses);

    const cloudClassIds = new Set(
      cloudClasses.map(item => item.id)
    );

    appData.records = Object.fromEntries(
      Object.entries(appData.records).filter(
        ([key]) => !cloudClassIds.has(key.split("|")[1])
      )
    );

    Object.assign(
      appData.records,
      cloudData.records || {}
    );

    currentTeacher = {
      id: user.uid,
      name: cloudData.name || user.email.split("@")[0],
      email: user.email
    };

    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(appData)
    );

    selectedClassId = null;
    selectedSectionId = null;

    showApp();
    $("loginForm").reset();

  } catch (error) {
    console.error("Login error:", error);

    if (
      error.code === "auth/invalid-credential" ||
      error.code === "auth/user-not-found" ||
      error.code === "auth/wrong-password"
    ) {
      message.textContent =
        "The email or password is incorrect.";
    } else {
      message.textContent =
        error.message || "Could not sign in. Please try again.";
    }

  } finally {
    $("loginBtn").disabled = false;
  }
});

// TEACHER LOGOUT

$("logoutBtn").addEventListener("click", async () => {
  try {
    await signOut(auth);

    localStorage.removeItem(SESSION_KEY);

    $("loginForm").reset();
    $("registerForm").reset();

    showAuth("You have logged out successfully.");

  } catch (error) {
    console.error("Logout error:", error);
    alert("Could not log out. Please try again.");
  }
});

// CLASS AND SECTION EVENTS

$("classSelect").addEventListener("change", () => {
  selectedClassId = $("classSelect").value || null;
  selectedSectionId = null;

  ensureSelection();
  renderAll();
});

$("sectionSelect").addEventListener("change", () => {
  selectedSectionId = $("sectionSelect").value || null;
  renderAll();
});

$("manageClassesBtn").addEventListener("click", () => {
  $("classManagerPanel").hidden = false;

  renderClassManager();

  $("classManagerPanel").scrollIntoView({
    behavior: "smooth",
    block: "start"
  });
});

$("closeManagerBtn").addEventListener("click", () => {
  $("classManagerPanel").hidden = true;
});

// CREATE CLASS

$("classForm").addEventListener("submit", event => {
  event.preventDefault();

  const name = $("newClassName").value.trim();
  const subject = $("newClassSubject").value.trim();
  const level = $("newClassLevel").value.trim();

  if (!name || !currentTeacher) return;

  const duplicate = getTeacherClasses().some(
    item => item.name.toLowerCase() === name.toLowerCase()
  );

  if (duplicate) {
    alert(
      "You already have a class with that name. Please choose another name."
    );
    return;
  }

  const newClass = createClassForTeacher(
    currentTeacher.id,
    name,
    subject,
    level
  );

  selectedClassId = newClass.id;
  selectedSectionId = newClass.sections[0].id;

  saveData();
  $("classForm").reset();
  renderAll();
});

// CREATE SECTION

$("sectionForm").addEventListener("submit", event => {
  event.preventDefault();

  const selectedClass = getSelectedClass();
  const name = $("newSectionName").value.trim();

  if (!selectedClass || !name) {
    alert("Choose or create a class first.");
    return;
  }

  if (
    selectedClass.sections.some(
      section => section.name.toLowerCase() === name.toLowerCase()
    )
  ) {
    alert(
      "That section already exists in this class. Please use another name."
    );
    return;
  }

  const section = {
    id: makeId("section"),
    name,
    students: []
  };

  selectedClass.sections.push(section);
  selectedSectionId = section.id;

  saveData();
  $("sectionForm").reset();
  renderAll();
});

// RENAME AND REMOVE CLASSES OR SECTIONS

$("classList").addEventListener("click", event => {
  const button = event.target.closest("button[data-action]");

  if (!button) return;

  const action = button.dataset.action;
  const classId = button.dataset.classId;

  const classItem = getTeacherClasses().find(
    item => item.id === classId
  );

  if (!classItem) return;

  if (action === "rename-class") {
    const newName = prompt(
      "Enter the new class name:",
      classItem.name
    );

    if (!newName || !newName.trim()) return;

    const cleanName = newName.trim();

    const duplicate = getTeacherClasses().some(
      item =>
        item.id !== classId &&
        item.name.toLowerCase() === cleanName.toLowerCase()
    );

    if (duplicate) {
      alert("Another class already uses that name.");
      return;
    }

    classItem.name = cleanName;
  }

  if (action === "delete-class") {
    if (getTeacherClasses().length <= 1) return;

    if (
      !confirm(
        `Remove ${classItem.name} and all of its sections, students, and attendance records?`
      )
    ) {
      return;
    }

    removeRecordsForClass(classId);

    appData.classes = appData.classes.filter(
      item => item.id !== classId
    );

    if (selectedClassId === classId) {
      selectedClassId = null;
      selectedSectionId = null;
    }
  }

  if (action === "rename-section") {
    const sectionId = button.dataset.sectionId;

    const section = classItem.sections.find(
      item => item.id === sectionId
    );

    if (!section) return;

    const newName = prompt(
      "Enter the new section name:",
      section.name
    );

    if (!newName || !newName.trim()) return;

    const cleanName = newName.trim();

    const duplicate = classItem.sections.some(
      item =>
        item.id !== sectionId &&
        item.name.toLowerCase() === cleanName.toLowerCase()
    );

    if (duplicate) {
      alert(
        "Another section in this class already uses that name."
      );
      return;
    }

    section.name = cleanName;
  }

  if (action === "delete-section") {
    const sectionId = button.dataset.sectionId;

    if (classItem.sections.length <= 1) return;

    const section = classItem.sections.find(
      item => item.id === sectionId
    );

    if (!section) return;

    if (
      !confirm(
        `Remove ${section.name}, its students, and its attendance records?`
      )
    ) {
      return;
    }

    removeRecordsForClass(classId, sectionId);

    classItem.sections = classItem.sections.filter(
      item => item.id !== sectionId
    );

    if (
      selectedClassId === classId &&
      selectedSectionId === sectionId
    ) {
      selectedSectionId = null;
    }
  }

  saveData();
  ensureSelection();
  renderAll();
});

// ATTENDANCE EVENTS

$("studentRows").addEventListener("change", event => {
  const studentId = event.target.dataset.statusId;

  if (!studentId) return;

  const key = makeRecordKey(
    $("attendanceDate").value,
    selectedClassId,
    selectedSectionId,
    studentId
  );

  const oldRecord = appData.records[key] || {
    reason: "",
    notes: ""
  };

  appData.records[key] = {
    ...oldRecord,
    status: event.target.value
  };

  if (!["Absent", "Late"].includes(event.target.value)) {
    appData.records[key].reason = "";
    appData.records[key].notes = "";
  }

  saveData();
  renderStudents();
});

// STUDENT EDIT, DELETE, AND REASON BUTTONS

$("studentRows").addEventListener("click", event => {
  const actionButton = event.target.closest(
    "button[data-student-action]"
  );

  if (actionButton) {
    const studentId = actionButton.dataset.studentId;
    const action = actionButton.dataset.studentAction;

    if (action === "edit") {
      editStudent(studentId);
    }

    if (action === "delete") {
      deleteStudent(studentId);
    }

    return;
  }

  const reasonButton = event.target.closest(
    "button[data-reason-id]"
  );

  if (reasonButton) {
    openReasonDialog(reasonButton.dataset.reasonId);
  }
});

// SAVE ABSENCE OR LATE REASON

$("saveReasonBtn").addEventListener("click", event => {
  event.preventDefault();

  if (!activeReasonStudent) return;

  const key = makeRecordKey(
    $("attendanceDate").value,
    selectedClassId,
    selectedSectionId,
    activeReasonStudent
  );

  const record = appData.records[key] || {
    status: "Absent",
    reason: "",
    notes: ""
  };

  record.reason = $("reasonSelect").value;
  record.notes = $("reasonNotes").value.trim();

  appData.records[key] = record;

  saveData();
  $("reasonDialog").close();

  activeReasonStudent = null;

  renderStudents();
});

// SEARCH, FILTER, AND DATE

$("attendanceDate").addEventListener(
  "change",
  renderStudents
);

$("historyDateSelect").addEventListener(
  "change",
  renderHistory
);

$("historyExportBtn").addEventListener(
  "click",
  exportAttendanceCSV
);

$("searchInput").addEventListener(
  "input",
  renderStudents
);

$("statusFilter").addEventListener(
  "change",
  renderStudents
);

// SAVE ATTENDANCE TO FIREBASE

$("saveBtn").addEventListener("click", async () => {
  const savedMessage = $("savedMessage");
  const saveBtn = $("saveBtn");

  saveBtn.disabled = true;

  savedMessage.textContent =
    "Saving attendance to the cloud...";

  try {
    if (!auth.currentUser || !currentTeacher) {
      throw new Error(
        "You are not signed in. Please log in again."
      );
    }

    if (!saveData()) {
      throw new Error(
        "Could not save the attendance data."
      );
    }

    await cloudSaveQueue;

    savedMessage.textContent =
      "Attendance successfully saved to the cloud!";

    setTimeout(() => {
      savedMessage.textContent =
        "Changes are saved to the cloud.";
    }, 2500);

  } catch (error) {
    console.error("Attendance save error:", error);

    savedMessage.textContent =
      "Cloud save failed. Please check your connection and try again.";

  } finally {
    saveBtn.disabled = false;
  }
});

// ADD STUDENT

$("addStudentBtn").addEventListener("click", () => {
  if (!getSelectedSection()) return;

  $("addStudentPanel").hidden = false;
  $("newStudentId").focus();
});

$("cancelAddBtn").addEventListener("click", () => {
  $("addStudentPanel").hidden = true;
  $("studentForm").reset();
});

// SAVE NEW STUDENT

$("studentForm").addEventListener("submit", event => {
  event.preventDefault();

  const section = getSelectedSection();

  if (!section) {
    alert(
      "Create a class and section before adding students."
    );
    return;
  }

  const id = $("newStudentId").value.trim();
  const name = $("newStudentName").value.trim();

  if (!id || !name) return;

  if (
    section.students.some(
      student => student.id.toLowerCase() === id.toLowerCase()
    )
  ) {
    alert(
      "That student ID already exists in this section. Please use a different ID."
    );
    return;
  }

  section.students.push({
    id,
    name
  });

  saveData();

  $("studentForm").reset();
  $("addStudentPanel").hidden = true;

  renderAll();
});

// START THE APP AND RESTORE FIREBASE SESSION

function startApp() {
  onAuthStateChanged(auth, async user => {
    if (user) {
      if (isCreatingAccount) return;

      try {
        const stateRef = doc(
          db,
          "teachers",
          user.uid,
          "appData",
          "state"
        );

        const snapshot = await getDoc(stateRef);

        if (!snapshot.exists()) {
          currentTeacher = null;

          showAuth(
            "Your teacher data could not be found. Please contact your administrator."
          );

          return;
        }

        const cloudData = snapshot.data();

        appData.classes = appData.classes.filter(
          item => item.teacherId !== user.uid
        );

        const cloudClasses = cloudData.classes || [];
        appData.classes.push(...cloudClasses);

        const cloudClassIds = new Set(
          cloudClasses.map(item => item.id)
        );

        appData.records = Object.fromEntries(
          Object.entries(appData.records).filter(
            ([key]) => !cloudClassIds.has(key.split("|")[1])
          )
        );

        Object.assign(
          appData.records,
          cloudData.records || {}
        );

        currentTeacher = {
          id: user.uid,
          name: cloudData.name || user.email.split("@")[0],
          email: user.email
        };

        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify(appData)
        );

        selectedClassId = null;
        selectedSectionId = null;

        showApp();

      } catch (error) {
        console.error(
          "Could not restore Firebase session:",
          error
        );

        currentTeacher = null;

        showAuth(
          "Could not load your cloud data. Please check your internet connection."
        );
      }

    } else {
      currentTeacher = null;
      localStorage.removeItem(SESSION_KEY);
      showAuth();
    }
  });

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./service-worker.js")
        .catch(error => console.warn(
          "Offline support could not be started.",
          error
        ));
    });
  }
}

startApp();
