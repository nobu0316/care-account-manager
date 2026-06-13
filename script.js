"use strict";

const STORAGE_KEY = "careAccountManagerDataV1";
const yen = new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY", maximumFractionDigits: 0 });

const pad = number => String(number).padStart(2, "0");
const dateKey = date => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const monthKey = date => `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
const parseDate = value => {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
};
const formatDate = value => value ? value.replaceAll("-", "/") : "未確認";
const formatYen = value => yen.format(Math.round(Number(value) || 0));
const createId = prefix => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const addMonths = (date, count) => new Date(date.getFullYear(), date.getMonth() + count, 1);
const endOfMonth = date => new Date(date.getFullYear(), date.getMonth() + 1, 0);
const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, character => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
}[character]));

function getInitialData() {
  const today = new Date();
  const confirmed = new Date(today.getFullYear(), today.getMonth(), Math.max(1, today.getDate() - 2));
  const currentMonth = monthKey(today);
  const year = today.getFullYear();
  const month = today.getMonth();
  const safeDate = day => dateKey(new Date(year, month, Math.min(day, endOfMonth(today).getDate())));

  return {
    settings: {
      accountLabel: "介護用口座",
      confirmedBalance: 286500,
      confirmedDate: dateKey(confirmed),
      alertThreshold: 50000
    },
    transactions: [
      { id: createId("tx"), date: safeDate(10), type: "expense", title: "介護施設費", amount: 128000, status: "planned", memo: "月額利用料", recurringId: "rec_facility", generatedMonth: currentMonth },
      { id: createId("tx"), date: safeDate(15), type: "income", title: "年金", amount: 174000, status: "planned", memo: "", recurringId: "rec_pension", generatedMonth: currentMonth },
      { id: createId("tx"), date: safeDate(20), type: "expense", title: "医療費", amount: 12000, status: "planned", memo: "概算", recurringId: null, generatedMonth: null },
      { id: createId("tx"), date: safeDate(25), type: "income", title: "家族補助", amount: 30000, status: "planned", memo: "", recurringId: "rec_support", generatedMonth: currentMonth }
    ],
    recurringItems: [
      { id: "rec_facility", title: "介護施設費", type: "expense", amount: 128000, dayType: "day", day: 10, repeatType: "monthly", months: [], enabled: true, memo: "月額利用料" },
      { id: "rec_pension", title: "年金", type: "income", amount: 174000, dayType: "day", day: 15, repeatType: "bimonthly", months: [], enabled: true, memo: "偶数月" },
      { id: "rec_support", title: "家族補助", type: "income", amount: 30000, dayType: "day", day: 25, repeatType: "monthly", months: [], enabled: true, memo: "" }
    ]
  };
}

function normalizeData(raw) {
  const fallback = getInitialData();
  if (!raw || typeof raw !== "object") throw new Error("データ形式が正しくありません。");
  return {
    settings: {
      accountLabel: String(raw.settings?.accountLabel || "介護用口座"),
      confirmedBalance: Number(raw.settings?.confirmedBalance) || 0,
      confirmedDate: String(raw.settings?.confirmedDate || ""),
      alertThreshold: Math.max(0, Number(raw.settings?.alertThreshold) || 0)
    },
    transactions: Array.isArray(raw.transactions) ? raw.transactions.map(item => ({
      id: String(item.id || createId("tx")),
      date: String(item.date || ""),
      type: item.type === "income" ? "income" : "expense",
      title: String(item.title || "名称なし"),
      amount: Math.abs(Number(item.amount) || 0),
      status: item.status === "actual" ? "actual" : "planned",
      memo: String(item.memo || ""),
      recurringId: item.recurringId ? String(item.recurringId) : null,
      generatedMonth: item.generatedMonth ? String(item.generatedMonth) : null
    })).filter(item => /^\d{4}-\d{2}-\d{2}$/.test(item.date)) : [],
    recurringItems: Array.isArray(raw.recurringItems) ? raw.recurringItems.map(item => ({
      id: String(item.id || createId("rec")),
      title: String(item.title || "名称なし"),
      type: item.type === "income" ? "income" : "expense",
      amount: Math.abs(Number(item.amount) || 0),
      dayType: item.dayType === "end" ? "end" : "day",
      day: Math.min(31, Math.max(1, Number(item.day) || 1)),
      repeatType: ["monthly", "bimonthly", "specified"].includes(item.repeatType) ? item.repeatType : "monthly",
      months: Array.isArray(item.months) ? item.months.map(Number).filter(month => month >= 1 && month <= 12) : [],
      enabled: item.enabled !== false,
      memo: String(item.memo || "")
    })) : fallback.recurringItems
  };
}

function loadData() {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (!stored) return getInitialData();
  try { return normalizeData(JSON.parse(stored)); }
  catch (error) {
    console.warn("保存データを読み込めませんでした。", error);
    return getInitialData();
  }
}

let state = loadData();
let selectedMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let toastTimer;

const elements = Object.fromEntries(
  [...document.querySelectorAll("[id]")].map(element => [element.id, element])
);

function saveData() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  elements.saveStatus.textContent = "保存しました";
  setTimeout(() => { elements.saveStatus.textContent = "端末内に保存"; }, 1200);
}

function showToast(message) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.add("show");
  toastTimer = setTimeout(() => elements.toast.classList.remove("show"), 2200);
}

function signedAmount(transaction) {
  return transaction.type === "income" ? transaction.amount : -transaction.amount;
}

function forecastAt(targetDate) {
  const confirmedDate = state.settings.confirmedDate;
  return state.transactions
    .filter(item => item.date > confirmedDate && parseDate(item.date) <= targetDate)
    .reduce((balance, item) => balance + signedAmount(item), state.settings.confirmedBalance);
}

function forecastStatus(balance) {
  if (balance < 0) return { text: "残高不足の見込み", className: "danger" };
  if (balance < state.settings.alertThreshold) return { text: "警告基準額を下回ります", className: "warning" };
  return { text: "基準額以上", className: "" };
}

function renderHome() {
  const now = new Date();
  const currentEnd = endOfMonth(now);
  const nextEnd = endOfMonth(addMonths(now, 1));
  const threeEnd = endOfMonth(addMonths(now, 3));
  const forecasts = [
    [elements.forecastCurrent, elements.forecastCurrentStatus, currentEnd],
    [elements.forecastNext, elements.forecastNextStatus, nextEnd],
    [elements.forecastThreeMonths, elements.forecastThreeStatus, threeEnd]
  ];

  elements.confirmedBalance.textContent = formatYen(state.settings.confirmedBalance);
  elements.confirmedDate.textContent = formatDate(state.settings.confirmedDate);

  forecasts.forEach(([amountElement, statusElement, date]) => {
    const balance = forecastAt(date);
    const status = forecastStatus(balance);
    amountElement.textContent = formatYen(balance);
    statusElement.textContent = status.text;
    amountElement.closest(".forecast-card").className = `forecast-card${amountElement === elements.forecastThreeMonths ? " wide" : ""}${status.className ? ` ${status.className}` : ""}`;
  });

  const warningPoints = forecasts.map(([, , date]) => ({ date, balance: forecastAt(date) }));
  const negative = warningPoints.find(point => point.balance < 0);
  const low = warningPoints.find(point => point.balance < state.settings.alertThreshold);
  if (negative) {
    elements.alertArea.innerHTML = `<div class="alert-card danger">残高不足の予測があります<p>${formatYen(negative.balance)}まで下がる見込みです。入金予定や費用をご確認ください。</p></div>`;
  } else if (low) {
    elements.alertArea.innerHTML = `<div class="alert-card warning">残高が警告基準額を下回る見込みです<p>設定中の基準額は${formatYen(state.settings.alertThreshold)}です。</p></div>`;
  } else {
    elements.alertArea.innerHTML = "";
  }

  const futureExpenses = state.transactions
    .filter(item => item.type === "expense" && item.status === "planned" && item.date >= dateKey(now))
    .sort((a, b) => a.date.localeCompare(b.date) || b.amount - a.amount);
  const nextExpense = futureExpenses[0];
  elements.nextExpenseTitle.textContent = nextExpense ? nextExpense.title : "予定はありません";
  elements.nextExpenseDetail.textContent = nextExpense
    ? `${formatDate(nextExpense.date)} ・ ${formatYen(nextExpense.amount)}`
    : "固定入出金から予定を作成できます";

  const currentKey = monthKey(now);
  const monthTransactions = state.transactions.filter(item => item.date.startsWith(currentKey));
  const income = monthTransactions.filter(item => item.type === "income").reduce((sum, item) => sum + item.amount, 0);
  const expense = monthTransactions.filter(item => item.type === "expense").reduce((sum, item) => sum + item.amount, 0);
  elements.monthIncome.textContent = `+${formatYen(income)}`;
  elements.monthExpense.textContent = `-${formatYen(expense)}`;
}

function renderTransactions() {
  const key = monthKey(selectedMonth);
  const items = state.transactions.filter(item => item.date.startsWith(key)).sort((a, b) => a.date.localeCompare(b.date));
  elements.selectedMonthLabel.textContent = `${selectedMonth.getFullYear()}年 ${selectedMonth.getMonth() + 1}月`;
  const net = items.reduce((sum, item) => sum + signedAmount(item), 0);
  elements.monthTotal.innerHTML = `月間収支 <strong class="${net >= 0 ? "income-text" : "expense-text"}">${net >= 0 ? "+" : ""}${formatYen(net)}</strong>`;

  if (!items.length) {
    elements.transactionList.innerHTML = `<div class="empty-state">この月の入出金はありません。<br>追加するか、固定設定から作成してください。</div>`;
    return;
  }
  elements.transactionList.innerHTML = items.map(item => {
    const date = parseDate(item.date);
    return `
      <article class="transaction-item">
        <div class="transaction-main">
          <div class="date-box">${date.getMonth() + 1}月<strong>${date.getDate()}</strong>日</div>
          <div>
            <div class="transaction-title">${escapeHtml(item.title)}</div>
            <div class="transaction-meta"><span class="status-badge ${item.status === "actual" ? "actual" : ""}">${item.status === "actual" ? "実績" : "予定"}</span>${item.memo ? ` ・ ${escapeHtml(item.memo)}` : ""}</div>
          </div>
          <div class="amount ${item.type === "income" ? "income-text" : "expense-text"}">${item.type === "income" ? "+" : "-"}${formatYen(item.amount)}</div>
        </div>
        <div class="item-actions">
          ${item.status === "planned" ? `<button class="mini-button" data-action="actual" data-id="${item.id}">実績にする</button>` : ""}
          <button class="mini-button" data-action="edit" data-id="${item.id}">編集</button>
          <button class="mini-button delete" data-action="delete" data-id="${item.id}">削除</button>
        </div>
      </article>`;
  }).join("");
}

function repeatLabel(item) {
  if (item.repeatType === "monthly") return "毎月";
  if (item.repeatType === "bimonthly") return "2か月ごと（偶数月）";
  return `${item.months.join("・") || "未指定"}月`;
}

function renderRecurring() {
  const items = [...state.recurringItems].sort((a, b) => Number(b.enabled) - Number(a.enabled));
  if (!items.length) {
    elements.recurringList.innerHTML = `<div class="empty-state">固定入出金はまだありません。</div>`;
    return;
  }
  elements.recurringList.innerHTML = items.map(item => `
    <article class="recurring-item ${item.enabled ? "" : "disabled"}">
      <div class="recurring-head">
        <div><span class="transaction-title">${escapeHtml(item.title)}</span><div class="amount ${item.type === "income" ? "income-text" : "expense-text"}">${item.type === "income" ? "+" : "-"}${formatYen(item.amount)}</div></div>
        <span class="status-badge ${item.enabled ? "actual" : ""}">${item.enabled ? "有効" : "無効"}</span>
      </div>
      <div class="recurring-details">
        <span>${item.dayType === "end" ? "月末" : `毎月${item.day}日`}</span><span>・</span><span>${repeatLabel(item)}</span>
        ${item.memo ? `<span>・ ${escapeHtml(item.memo)}</span>` : ""}
      </div>
      <div class="item-actions">
        <button class="mini-button" data-rec-action="toggle" data-id="${item.id}">${item.enabled ? "無効にする" : "有効にする"}</button>
        <button class="mini-button" data-rec-action="edit" data-id="${item.id}">編集</button>
        <button class="mini-button delete" data-rec-action="delete" data-id="${item.id}">削除</button>
      </div>
    </article>`).join("");
}

function renderAll() {
  renderHome();
  renderTransactions();
  renderRecurring();
}

function navigate(screenName) {
  document.querySelectorAll(".screen").forEach(screen => screen.classList.toggle("active", screen.dataset.screen === screenName));
  document.querySelectorAll(".nav-item").forEach(item => item.classList.toggle("active", item.dataset.nav === screenName));
  window.scrollTo({ top: 0, behavior: "smooth" });
  if (screenName === "transactions") renderTransactions();
}

function openTransaction(item = null, makeActual = false) {
  elements.transactionDialogTitle.textContent = item ? (makeActual ? "実績として確認" : "入出金を編集") : "入出金を追加";
  elements.transactionId.value = item?.id || "";
  elements.transactionDate.value = item?.date || dateKey(new Date());
  elements.transactionType.value = item?.type || "expense";
  elements.transactionTitle.value = item?.title || "";
  elements.transactionAmount.value = item?.amount || "";
  elements.transactionStatus.value = makeActual ? "actual" : (item?.status || "planned");
  elements.transactionMemo.value = item?.memo || "";
  elements.transactionDialog.showModal();
}

function openRecurring(item = null) {
  elements.recurringDialogTitle.textContent = item ? "固定入出金を編集" : "固定入出金を追加";
  elements.recurringId.value = item?.id || "";
  elements.recurringTitle.value = item?.title || "";
  elements.recurringType.value = item?.type || "expense";
  elements.recurringAmount.value = item?.amount || "";
  elements.recurringDayType.value = item?.dayType || "day";
  elements.recurringDay.value = item?.day || 10;
  elements.recurringRepeatType.value = item?.repeatType || "monthly";
  elements.recurringEnabled.checked = item?.enabled ?? true;
  elements.recurringMemo.value = item?.memo || "";
  document.querySelectorAll("[data-month-check]").forEach(input => { input.checked = item?.months?.includes(Number(input.value)) || false; });
  updateRecurringFields();
  elements.recurringDialog.showModal();
}

function updateRecurringFields() {
  elements.recurringDayLabel.classList.toggle("hidden", elements.recurringDayType.value === "end");
  elements.monthsField.classList.toggle("hidden", elements.recurringRepeatType.value !== "specified");
}

function shouldGenerate(item, targetDate) {
  if (!item.enabled) return false;
  const month = targetDate.getMonth() + 1;
  if (item.repeatType === "monthly") return true;
  if (item.repeatType === "bimonthly") return month % 2 === 0;
  return item.months.includes(month);
}

function generateForMonths(startDate, count) {
  let created = 0;
  for (let offset = 0; offset < count; offset += 1) {
    const target = addMonths(startDate, offset);
    const generatedMonth = monthKey(target);
    state.recurringItems.forEach(item => {
      if (!shouldGenerate(item, target)) return;
      const duplicate = state.transactions.some(transaction =>
        transaction.recurringId === item.id && transaction.generatedMonth === generatedMonth
      );
      if (duplicate) return;
      const lastDay = endOfMonth(target).getDate();
      const day = item.dayType === "end" ? lastDay : Math.min(item.day, lastDay);
      state.transactions.push({
        id: createId("tx"), date: dateKey(new Date(target.getFullYear(), target.getMonth(), day)),
        type: item.type, title: item.title, amount: item.amount, status: "planned",
        memo: item.memo, recurringId: item.id, generatedMonth
      });
      created += 1;
    });
  }
  saveData();
  renderAll();
  showToast(created ? `${created}件の予定を作成しました` : "作成済みのため追加はありません");
}

function confirmDelete(message) {
  return window.confirm(message);
}

document.querySelectorAll("[data-nav]").forEach(button => button.addEventListener("click", () => navigate(button.dataset.nav)));
document.querySelectorAll("[data-nav-target]").forEach(button => button.addEventListener("click", () => navigate(button.dataset.navTarget)));

elements.openBalanceModal.addEventListener("click", () => {
  elements.balanceDateInput.value = state.settings.confirmedDate || dateKey(new Date());
  elements.balanceAmountInput.value = state.settings.confirmedBalance;
  elements.balanceDialog.showModal();
});
elements.balanceForm.addEventListener("submit", event => {
  event.preventDefault();
  state.settings.confirmedDate = elements.balanceDateInput.value;
  state.settings.confirmedBalance = Number(elements.balanceAmountInput.value);
  saveData(); renderAll(); elements.balanceDialog.close(); showToast("確認済み残高を更新しました");
});

elements.openThresholdModal.addEventListener("click", () => {
  elements.thresholdInput.value = state.settings.alertThreshold;
  elements.thresholdDialog.showModal();
});
elements.thresholdForm.addEventListener("submit", event => {
  event.preventDefault();
  state.settings.alertThreshold = Number(elements.thresholdInput.value);
  saveData(); renderHome(); elements.thresholdDialog.close(); showToast("警告基準額を保存しました");
});

elements.addTransactionButton.addEventListener("click", () => openTransaction());
elements.transactionForm.addEventListener("submit", event => {
  event.preventDefault();
  const id = elements.transactionId.value;
  const previous = state.transactions.find(item => item.id === id);
  const transaction = {
    id: id || createId("tx"), date: elements.transactionDate.value, type: elements.transactionType.value,
    title: elements.transactionTitle.value.trim(), amount: Math.abs(Number(elements.transactionAmount.value)),
    status: elements.transactionStatus.value, memo: elements.transactionMemo.value.trim(),
    recurringId: previous?.recurringId || null, generatedMonth: previous?.generatedMonth || null
  };
  if (previous) Object.assign(previous, transaction); else state.transactions.push(transaction);
  saveData(); renderAll(); elements.transactionDialog.close(); showToast(previous ? "入出金を更新しました" : "入出金を追加しました");
});

elements.transactionList.addEventListener("click", event => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const item = state.transactions.find(transaction => transaction.id === button.dataset.id);
  if (!item) return;
  if (button.dataset.action === "edit") openTransaction(item);
  if (button.dataset.action === "actual") openTransaction(item, true);
  if (button.dataset.action === "delete" && confirmDelete(`「${item.title}」を削除しますか？`)) {
    state.transactions = state.transactions.filter(transaction => transaction.id !== item.id);
    saveData(); renderAll(); showToast("入出金を削除しました");
  }
});
elements.previousMonth.addEventListener("click", () => { selectedMonth = addMonths(selectedMonth, -1); renderTransactions(); });
elements.nextMonth.addEventListener("click", () => { selectedMonth = addMonths(selectedMonth, 1); renderTransactions(); });
elements.goCurrentMonth.addEventListener("click", () => { selectedMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1); renderTransactions(); });

elements.monthChecks.innerHTML = Array.from({ length: 12 }, (_, index) =>
  `<label><input type="checkbox" value="${index + 1}" data-month-check>${index + 1}月</label>`
).join("");
elements.addRecurringButton.addEventListener("click", () => openRecurring());
elements.recurringDayType.addEventListener("change", updateRecurringFields);
elements.recurringRepeatType.addEventListener("change", updateRecurringFields);
elements.recurringForm.addEventListener("submit", event => {
  event.preventDefault();
  const id = elements.recurringId.value;
  const previous = state.recurringItems.find(item => item.id === id);
  const recurring = {
    id: id || createId("rec"), title: elements.recurringTitle.value.trim(), type: elements.recurringType.value,
    amount: Math.abs(Number(elements.recurringAmount.value)), dayType: elements.recurringDayType.value,
    day: Number(elements.recurringDay.value) || 1, repeatType: elements.recurringRepeatType.value,
    months: [...document.querySelectorAll("[data-month-check]:checked")].map(input => Number(input.value)),
    enabled: elements.recurringEnabled.checked, memo: elements.recurringMemo.value.trim()
  };
  if (recurring.repeatType === "specified" && !recurring.months.length) {
    showToast("指定月を1つ以上選んでください");
    return;
  }
  if (previous) Object.assign(previous, recurring); else state.recurringItems.push(recurring);
  saveData(); renderAll(); elements.recurringDialog.close(); showToast(previous ? "固定設定を更新しました" : "固定設定を追加しました");
});

elements.recurringList.addEventListener("click", event => {
  const button = event.target.closest("[data-rec-action]");
  if (!button) return;
  const item = state.recurringItems.find(recurring => recurring.id === button.dataset.id);
  if (!item) return;
  if (button.dataset.recAction === "edit") openRecurring(item);
  if (button.dataset.recAction === "toggle") {
    item.enabled = !item.enabled; saveData(); renderRecurring(); showToast(item.enabled ? "有効にしました" : "無効にしました");
  }
  if (button.dataset.recAction === "delete" && confirmDelete(`「${item.title}」の固定設定を削除しますか？\n作成済みの入出金は残ります。`)) {
    state.recurringItems = state.recurringItems.filter(recurring => recurring.id !== item.id);
    saveData(); renderRecurring(); showToast("固定設定を削除しました");
  }
});
document.querySelectorAll("[data-generate]").forEach(button => button.addEventListener("click", () => {
  const now = new Date();
  if (button.dataset.generate === "current") generateForMonths(now, 1);
  if (button.dataset.generate === "next") generateForMonths(addMonths(now, 1), 1);
  if (button.dataset.generate === "three") generateForMonths(now, 3);
}));

elements.exportButton.addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `介護用口座_${dateKey(new Date())}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
  showToast("バックアップを保存しました");
});

elements.importInput.addEventListener("change", async event => {
  const file = event.target.files[0];
  if (!file) return;
  if (!window.confirm("インポートすると、現在のデータはすべて置き換わります。\n続けますか？")) {
    event.target.value = ""; return;
  }
  try {
    state = normalizeData(JSON.parse(await file.text()));
    saveData(); renderAll(); showToast("データを復元しました");
  } catch (error) {
    window.alert(`読み込みに失敗しました。\n${error.message}`);
  }
  event.target.value = "";
});

elements.resetButton.addEventListener("click", () => {
  if (!window.confirm("すべてのデータを初期状態に戻します。\nこの操作は取り消せません。続けますか？")) return;
  state = getInitialData(); saveData(); renderAll(); showToast("初期状態に戻しました");
});

document.querySelectorAll("dialog").forEach(dialog => dialog.addEventListener("click", event => {
  if (event.target === dialog) dialog.close();
}));
document.querySelectorAll("[data-close-dialog]").forEach(button => button.addEventListener("click", () => {
  button.closest("dialog").close();
}));

renderAll();
