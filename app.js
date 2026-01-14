import { dbGetMeta, dbSetMeta, dbAddType, dbGetTypes, dbAddTransactions, dbGetAllTx } from "./db.js";

const AUTO_LOCK_MS = 2 * 60 * 1000; // 2분 자동잠금

// ---------- 유틸 ----------
const $ = (id) => document.getElementById(id);
const fmt = (n) => (Number(n || 0)).toLocaleString("ko-KR");
const todayStr = () => {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth()+1).padStart(2,"0");
  const dd = String(d.getDate()).padStart(2,"0");
  return `${yyyy}-${mm}-${dd}`;
};
const yearOf = (dateStr) => Number(String(dateStr).slice(0,4));
function toYMD(d){
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth()+1).padStart(2,"0");
  const dd = String(d.getDate()).padStart(2,"0");
  return `${yyyy}-${mm}-${dd}`;
}

// dateStr(YYYY-MM-DD)이 속한 주의 "정산일(일요일)"을 반환
// - 일요일이면 그대로 그 날짜
// - 월~토이면 "다가오는 일요일" 날짜
function weekEndSunday(dateStr){
  const [y,m,d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m-1, d);
  const day = dt.getDay(); // 0=일 ... 6=토
  const add = (7 - day) % 7; // 일(0)이면 0, 월(1)이면 6, 토(6)이면 1
  dt.setDate(dt.getDate() + add);
  return toYMD(dt);
}



// ---------- 상태 ----------
let lastActivity = Date.now();
let isLocked = true;
let pinHash = null; // 저장된 PIN 해시(문자열)
let knownNames = new Set(); // 최근 입력 이름 자동완성(간단 버전)
let currentTx = []; // 전체 거래 캐시

// ---------- 간단 해시(보안 목적 설명) ----------
// 서버 없는 로컬 PIN 확인용(암호학적 완벽함보다 "앱 잠금" 목적)
// iOS 분실 대비는 "기기 잠금(FaceID)"과 함께 쓰시는 것을 권장드립니다.
async function sha256(text) {
  const enc = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2,"0")).join("");
}

// ---------- 서비스워커 ----------
async function setupSW(){
  if ("serviceWorker" in navigator) {
    try { await navigator.serviceWorker.register("./sw.js"); } catch {}
  }
}

// ---------- 탭 ----------
function setupTabs(){
  document.querySelectorAll(".tab").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      const tab = btn.dataset.tab;
      ["entry","person","type","date","week"].forEach(t => {
        $(`tab-${t}`).classList.toggle("hidden", t !== tab);
      });
      if (tab !== "entry") renderReports();
    });
  });
}

// ---------- 잠금 ----------
function showLock(show, modeText){
  const lock = $("lockScreen");
  lock.classList.toggle("hidden", !show);
  lock.setAttribute("aria-hidden", String(!show));
  isLocked = show;
  $("pinInput").value = "";
  $("lockTitle").textContent = modeText || "잠금 해제";
}

function touchActivity(){
  lastActivity = Date.now();
}

function setupAutoLock(){
  const bump = () => touchActivity();
  ["click","touchstart","keydown","scroll"].forEach(ev => window.addEventListener(ev, bump, { passive:true }));

  // 화면이 백그라운드로 가면 즉시 잠금(권장)
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) lockNow();
  });

  setInterval(() => {
    if (!isLocked && Date.now() - lastActivity > AUTO_LOCK_MS) {
      lockNow();
    }
  }, 1000);
}

function lockNow(){
  showLock(true, "잠금 해제");
}

async function setupPIN(){
  pinHash = await dbGetMeta("pin_hash");
  const hasPin = !!pinHash;

  $("btnResetPin").classList.toggle("hidden", !hasPin);
  $("lockHint").textContent = hasPin
    ? "PIN을 입력해 주세요."
    : "처음 사용입니다. PIN(4~8자리)을 설정해 주세요.";

  showLock(true, hasPin ? "잠금 해제" : "PIN 설정");

  $("btnPinOk").addEventListener("click", async () => {
    const pin = $("pinInput").value.trim();
    if (!/^\d{4,8}$/.test(pin)) {
      alert("PIN은 숫자 4~8자리로 입력해 주세요.");
      return;
    }

    if (!pinHash) {
      const h = await sha256(pin);
      await dbSetMeta("pin_hash", h);
      pinHash = h;
      alert("PIN이 설정되었습니다.");
      showLock(false);
      touchActivity();
      return;
    }

    const h = await sha256(pin);
    if (h !== pinHash) {
      alert("PIN이 올바르지 않습니다.");
      return;
    }
    showLock(false);
    touchActivity();
  });

  $("btnLock").addEventListener("click", lockNow);

  $("btnResetPin").addEventListener("click", async () => {
    const ok = confirm("PIN을 초기화하시겠습니까?\n(초기화 후 새 PIN을 설정할 수 있습니다)");
    if (!ok) return;
    await dbSetMeta("pin_hash", null);
    pinHash = null;
    alert("PIN이 초기화되었습니다. 새 PIN을 설정해 주세요.");
    $("btnResetPin").classList.add("hidden");
    $("lockHint").textContent = "처음 사용입니다. PIN(4~8자리)을 설정해 주세요.";
    showLock(true, "PIN 설정");
  });
}

// ---------- 입력 UI ----------
function makeRow(name = "", amount = "") {
  const row = document.createElement("div");
  row.className = "trow";

  const nameInput = document.createElement("input");
  nameInput.placeholder = "예: 홍길동";
  nameInput.value = name;

  // 간단 자동완성: datalist 사용
  const listId = "namesList";
  let dl = document.getElementById(listId);
  if (!dl) {
    dl = document.createElement("datalist");
    dl.id = listId;
    document.body.appendChild(dl);
  }
  nameInput.setAttribute("list", listId);

  const amountInput = document.createElement("input");
  amountInput.inputMode = "numeric";
  amountInput.placeholder = "예: 100000";
  amountInput.value = amount;
  amountInput.addEventListener("input", () => {
    // 숫자만
    amountInput.value = amountInput.value.replace(/[^\d]/g, "");
  });
    const tryAutoAddRow = (e) => {
    const rowsWrap = $("rows");
    const isLastRow = rowsWrap.lastElementChild === row;

    const personVal = nameInput.value.trim();
    const amountVal = amountInput.value.trim();

    if (!isLastRow) return;
    if (!personVal || !amountVal) return; // 둘 다 있어야 자동 추가

    // 새 행 추가
    const newRow = makeRow();
    rowsWrap.appendChild(newRow);

    // 새 행의 이름칸으로 포커스 이동
    const newNameInput = newRow.querySelector("input");
    setTimeout(() => newNameInput.focus(), 0);
  };

  amountInput.addEventListener("keydown", (e) => {
    // 마지막 금액칸에서 Tab(앞으로) 또는 Enter면 행 추가
    if ((e.key === "Tab" && !e.shiftKey) || e.key === "Enter") {
      // Tab은 기본 동작을 막고 우리가 새 행으로 이동시키기
      e.preventDefault();
      tryAutoAddRow(e);
    }
  });


  const delBtn = document.createElement("button");
  delBtn.className = "icon-btn";
  delBtn.textContent = "✕";
  delBtn.addEventListener("click", () => row.remove());

  row.appendChild(nameInput);
  row.appendChild(amountInput);
  row.appendChild(delBtn);
  return row;
}

async function refreshNameDatalist() {
  const dl = document.getElementById("namesList");
  if (!dl) return;
  dl.innerHTML = "";
  [...knownNames].slice(0, 200).forEach(n => {
    const opt = document.createElement("option");
    opt.value = n;
    dl.appendChild(opt);
  });
}

async function setupEntry(){
  $("entryDate").value = todayStr();

  // 종류 로드
  const types = await dbGetTypes();
  const sel = $("donationType");
  sel.innerHTML = "";
  types.sort((a,b)=>a.name.localeCompare(b.name,"ko")).forEach(t => {
    const opt = document.createElement("option");
    opt.value = t.name;
    opt.textContent = t.name;
    sel.appendChild(opt);
  });

  $("btnAddType").addEventListener("click", async () => {
    const name = $("newTypeName").value.trim();
    if (!name) return;
    await dbAddType(name);
    $("newTypeName").value = "";
    await setupEntry(); // 간단 리프레시
  });

  // 기본 3줄 제공
  const rows = $("rows");
  rows.innerHTML = "";
  rows.appendChild(makeRow());
  rows.appendChild(makeRow());
  rows.appendChild(makeRow());

  $("btnAddRow").addEventListener("click", () => {
    rows.appendChild(makeRow());
  });

  $("btnSave").addEventListener("click", async () => {
    if (isLocked) return alert("잠금 해제 후 사용해 주세요.");

    const date = $("entryDate").value;
    const type = $("donationType").value;

    if (!date) return alert("날짜를 선택해 주세요.");
    if (!type) return alert("헌금종류를 선택해 주세요.");

    const items = [];
    const rowEls = [...rows.querySelectorAll(".trow")];

    for (const r of rowEls) {
      const inputs = r.querySelectorAll("input");
      const person = (inputs[0].value || "").trim();
      const amountStr = (inputs[1].value || "").trim();

      if (!person && !amountStr) continue; // 빈 줄 스킵
      if (!person) return alert("헌금자 이름이 비어있는 줄이 있습니다.");
      if (!amountStr) return alert("금액이 비어있는 줄이 있습니다.");

      const amount = Number(amountStr);
      if (!Number.isFinite(amount) || amount <= 0) return alert("금액은 0보다 큰 숫자여야 합니다.");

      items.push({
        date,
        year: yearOf(date),
        weekStart: weekEndSunday(date), // ✅ 주간정산일(일요일)
        type,
        person,
        amount,
        createdAt: Date.now()
      });

      knownNames.add(person);
    }

    if (items.length === 0) return alert("저장할 내용이 없습니다.");

    await dbAddTransactions(items);
    await loadAllTx();
    await refreshNameDatalist();

    alert(`저장되었습니다. (${items.length}건)`);
    // 입력칸 초기화(이름/금액만)
    rowEls.forEach(r => {
      const inputs = r.querySelectorAll("input");
      inputs[0].value = "";
      inputs[1].value = "";
    });
  });
}

// ---------- 리포트 ----------
function yearsFromTx() {
  const ys = new Set(currentTx.map(t => t.year));
  const list = [...ys].sort((a,b)=>b-a);
  const nowY = new Date().getFullYear();
  if (!ys.has(nowY)) list.unshift(nowY);
  return list;
}

function fillYearSelect(selId){
  const sel = $(selId);
  const years = yearsFromTx();
  sel.innerHTML = "";
  years.forEach(y => {
    const opt = document.createElement("option");
    opt.value = String(y);
    opt.textContent = String(y);
    sel.appendChild(opt);
  });
  sel.value = String(new Date().getFullYear());
}

function groupSum(arr, keyFn) {
  const m = new Map();
  for (const it of arr) {
    const k = keyFn(it);
    m.set(k, (m.get(k) || 0) + it.amount);
  }
  return m;
}

function renderList(targetId, entries, makeSub){
  const wrap = $(targetId);
  wrap.innerHTML = "";
  entries.forEach(([k, sum]) => {
    const div = document.createElement("div");
    div.className = "item";
    div.innerHTML = `
      <div class="top">
        <div class="name">${k}</div>
        <div class="sum">${fmt(sum)}원</div>
      </div>
      <div class="sub">${makeSub ? makeSub(k) : ""}</div>
    `;
    wrap.appendChild(div);
  });
  if (entries.length === 0) {
    wrap.innerHTML = `<div class="item"><div class="sub">표시할 데이터가 없습니다.</div></div>`;
  }
}

function renderReports(){
  fillYearSelect("yearPerson");
  fillYearSelect("yearType");
  fillYearSelect("yearDate");

  // 공통: 연도 필터
  const yP = Number($("yearPerson").value);
  const yT = Number($("yearType").value);
  const yD = Number($("yearDate").value);

  // 개인별
  const q = ($("personSearch").value || "").trim();
  const txP = currentTx.filter(t => t.year === yP && (!q || t.person.includes(q)));
  const byPerson = groupSum(txP, t => t.person);
  const listP = [...byPerson.entries()].sort((a,b)=>b[1]-a[1]);
  renderList("personSummary", listP, (person) => {
    const mine = txP.filter(t => t.person === person);
    const byType = groupSum(mine, t => t.type);
    const topTypes = [...byType.entries()].sort((a,b)=>b[1]-a[1]).slice(0,4);
    const parts = topTypes.map(([k,v]) => `${k} ${fmt(v)}원`);
    return parts.length ? `주요 항목: ${parts.join(" · ")}` : "";
  });

  // 종류별
  const txT = currentTx.filter(t => t.year === yT);
  const byType = groupSum(txT, t => t.type);
  const listT = [...byType.entries()].sort((a,b)=>b[1]-a[1]);
  renderList("typeSummary", listT, (type) => {
    const mine = txT.filter(t => t.type === type);
    const byPerson2 = groupSum(mine, t => t.person);
    const topPeople = [...byPerson2.entries()].sort((a,b)=>b[1]-a[1]).slice(0,3);
    const parts = topPeople.map(([k,v]) => `${k} ${fmt(v)}원`);
    return parts.length ? `상위 헌금자: ${parts.join(" · ")}` : "";
  });

  // 날짜별
  const txD = currentTx.filter(t => t.year === yD);
  const byDate = groupSum(txD, t => t.date);
  const listD = [...byDate.entries()].sort((a,b)=>a[0].localeCompare(b[0]));
  renderList("dateSummary", listD, (date) => {
    const mine = txD.filter(t => t.date === date);
    const byType2 = groupSum(mine, t => t.type);
    const parts = [...byType2.entries()].sort((a,b)=>b[1]-a[1]).map(([k,v]) => `${k} ${fmt(v)}원`);
    return parts.length ? parts.join(" · ") : "";
  });
      // 주간(정산일=일요일 마감)
  fillYearSelect("yearWeek");
  const yW = Number($("yearWeek").value);

  const byWeek = new Map();
  for (const t of currentTx) {
    const we = t.weekEnd || weekEndSunday(t.date);
    const weYear = yearOf(we); // ✅ 주간 연도는 정산일 연도 기준
    if (weYear !== yW) continue;
    byWeek.set(we, (byWeek.get(we) || 0) + t.amount);
  }

  const listW = [...byWeek.entries()].sort((a,b)=>a[0].localeCompare(b[0]));

  renderList("weekSummary", listW, (we) => {
    // 범위: 월~일(정산일)
    const [y,m,d] = we.split("-").map(Number);
    const end = new Date(y, m-1, d);   // 일요일
    const start = new Date(y, m-1, d);
    start.setDate(start.getDate() - 6); // 월요일

    const range = `${toYMD(start)} ~ ${toYMD(end)} (정산일)`;

    const mine = currentTx.filter(t => (t.weekEnd || weekEndSunday(t.date)) === we);
    const byType2 = groupSum(mine, t => t.type);
    const parts = [...byType2.entries()]
      .sort((a,b)=>b[1]-a[1])
      .map(([k,v]) => `${k} ${fmt(v)}원`);

    return `${range}<br/>${parts.length ? parts.join(" · ") : ""}`;
  });


}

function setupReportEvents(){
  $("yearPerson").addEventListener("change", renderReports);
  $("yearType").addEventListener("change", renderReports);
  $("yearDate").addEventListener("change", renderReports);
  $("personSearch").addEventListener("input", renderReports);
  $("yearWeek").addEventListener("change", renderReports);

}

// ---------- 데이터 로드 ----------
async function loadAllTx(){
  currentTx = await dbGetAllTx();
  // 이름 목록도 갱신
  currentTx.forEach(t => knownNames.add(t.person));
  await refreshNameDatalist();
}

// ---------- 시작 ----------
(async function init(){
  await setupSW();
  setupTabs();
  setupAutoLock();
  await loadAllTx();
  await setupEntry();
  setupReportEvents();
  await setupPIN(); // 마지막에 잠금 UI
})();
