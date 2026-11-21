"use strict";

const STORAGE_KEY = "careAccountManagerDataV1";
const SCHEMA_VERSION = 2;
const BALANCE_REVIEW_DAYS = 30;
const HOME_UPCOMING_LIMIT = 4;
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
const cloneData = value => JSON.parse(JSON.stringify(value));
const isPlainObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const currentJapanMonth = (now = new Date()) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit"
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}`;
};
const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, character => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
}[character]));

function getInitialData() {
  return {
    schemaVersion: SCHEMA_VERSION,
    settings: {
      accountLabel: "介護用口座",
      confirmedBalance: null,
      confirmedDate: "",
      alertThreshold: 50000
    },
    transactions: [],
    recurringItems: [],
    recurringRuleVersions: [],
    recurringAdjustments: []
  };
}

function getProtectedEmptyData() {
  // This view is never saved while storageProtectionError is active.
  return getInitialData();
}

function isBalanceConfigured(data = state) {
  return Number.isSafeInteger(data.settings.confirmedBalance) && isValidDate(data.settings.confirmedDate);
}

function validationError(path, message) {
  throw new Error(`${path}: ${message}`);
}

function isValidId(value) {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,120}$/.test(value);
}

function isValidMonth(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}$/.test(value)) return false;
  const month = Number(value.slice(5, 7));
  return month >= 1 && month <= 12;
}

function isValidDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = parseDate(value);
  return !Number.isNaN(parsed.getTime()) && dateKey(parsed) === value;
}

function requireText(value, path, { allowEmpty = false } = {}) {
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) validationError(path, "文字列が不正です");
  return value;
}

function requireAmount(value, path, { allowZero = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) validationError(path, "金額が不正です");
  return value;
}

function normalizeRecurringRule(item, path) {
  if (!isPlainObject(item)) validationError(path, "固定設定がオブジェクトではありません");
  if (!isValidId(item.id)) validationError(`${path}.id`, "IDが不正です");
  if (!["income", "expense"].includes(item.type)) validationError(`${path}.type`, "種別が不正です");
  if (!["day", "end"].includes(item.dayType)) validationError(`${path}.dayType`, "発生日種別が不正です");
  if (!["monthly", "bimonthly", "specified"].includes(item.repeatType)) validationError(`${path}.repeatType`, "繰り返し種別が不正です");
  if (!Number.isInteger(item.day) || item.day < 1 || item.day > 31) validationError(`${path}.day`, "日が不正です");
  if (!Array.isArray(item.months)) validationError(`${path}.months`, "対象月が配列ではありません");
  const months = item.months.map((month, index) => {
    if (!Number.isInteger(month) || month < 1 || month > 12) validationError(`${path}.months[${index}]`, "対象月が不正です");
    return month;
  });
  if (new Set(months).size !== months.length) validationError(`${path}.months`, "対象月が重複しています");
  if (item.repeatType === "specified" && !months.length) validationError(`${path}.months`, "指定月がありません");
  if (typeof item.enabled !== "boolean") validationError(`${path}.enabled`, "有効状態が不正です");
  return {
    id: item.id,
    title: requireText(item.title, `${path}.title`),
    type: item.type,
    amount: requireAmount(item.amount, `${path}.amount`),
    dayType: item.dayType,
    day: item.day,
    repeatType: item.repeatType,
    months,
    enabled: item.enabled,
    memo: requireText(item.memo ?? "", `${path}.memo`, { allowEmpty: true })
  };
}

function normalizeTransaction(item, path) {
  if (!isPlainObject(item)) validationError(path, "取引がオブジェクトではありません");
  if (!isValidId(item.id)) validationError(`${path}.id`, "IDが不正です");
  if (!isValidDate(item.date)) validationError(`${path}.date`, "日付が不正です");
  if (!["income", "expense"].includes(item.type)) validationError(`${path}.type`, "種別が不正です");
  if (!["planned", "actual"].includes(item.status)) validationError(`${path}.status`, "状態が不正です");
  const recurringId = item.recurringId == null ? null : item.recurringId;
  const generatedMonth = item.generatedMonth == null ? null : item.generatedMonth;
  if (recurringId !== null && !isValidId(recurringId)) validationError(`${path}.recurringId`, "固定設定IDが不正です");
  if (generatedMonth !== null && !isValidMonth(generatedMonth)) validationError(`${path}.generatedMonth`, "元の予定月が不正です");
  if (generatedMonth !== null && recurringId === null) validationError(path, "元の予定月に固定設定IDがありません");
  return {
    id: item.id,
    date: item.date,
    type: item.type,
    title: requireText(item.title, `${path}.title`),
    amount: requireAmount(item.amount, `${path}.amount`),
    status: item.status,
    memo: requireText(item.memo ?? "", `${path}.memo`, { allowEmpty: true }),
    recurringId,
    generatedMonth
  };
}

function dedupeLatest(items, keyOf) {
  const result = [];
  const indexes = new Map();
  items.forEach(item => {
    const key = keyOf(item);
    if (indexes.has(key)) result[indexes.get(key)] = item;
    else { indexes.set(key, result.length); result.push(item); }
  });
  return result;
}

function normalizeData(raw) {
  if (!isPlainObject(raw)) throw new Error("データ形式が正しくありません。");
  const sourceVersion = raw.schemaVersion == null ? 1 : raw.schemaVersion;
  if (sourceVersion !== 1 && sourceVersion !== SCHEMA_VERSION) {
    throw new Error(`未対応のschemaVersionです: ${String(sourceVersion)}`);
  }
  if (!isPlainObject(raw.settings)) validationError("settings", "設定がありません");
  if (!Array.isArray(raw.transactions)) validationError("transactions", "取引配列がありません");
  if (!Array.isArray(raw.recurringItems)) validationError("recurringItems", "固定設定配列がありません");

  const confirmedDate = raw.settings.confirmedDate ?? "";
  if (confirmedDate !== "" && !isValidDate(confirmedDate)) validationError("settings.confirmedDate", "確認日が不正です");
  const balanceIsUnset = sourceVersion === 2 && raw.settings.confirmedBalance === null;
  if (balanceIsUnset && confirmedDate !== "") validationError("settings", "未設定残高に確認日は指定できません");
  const settings = {
    accountLabel: requireText(raw.settings.accountLabel, "settings.accountLabel"),
    confirmedBalance: balanceIsUnset ? null : requireAmount(raw.settings.confirmedBalance, "settings.confirmedBalance", { allowZero: true }),
    confirmedDate,
    alertThreshold: requireAmount(raw.settings.alertThreshold, "settings.alertThreshold", { allowZero: true })
  };

  const transactions = raw.transactions.map((item, index) => normalizeTransaction(item, `transactions[${index}]`));
  const recurringItems = raw.recurringItems.map((item, index) => normalizeRecurringRule(item, `recurringItems[${index}]`));
  const transactionIds = new Set();
  const occurrenceKeys = new Set();
  transactions.forEach(item => {
    if (transactionIds.has(item.id)) validationError("transactions", `取引IDが重複しています: ${item.id}`);
    transactionIds.add(item.id);
    if (item.recurringId && item.generatedMonth) {
      const key = `${item.recurringId}|${item.generatedMonth}`;
      if (occurrenceKeys.has(key)) validationError("transactions", `固定取引の発生キーが重複しています: ${key}`);
      occurrenceKeys.add(key);
    }
  });
  const recurringIds = new Set();
  recurringItems.forEach(item => {
    if (recurringIds.has(item.id)) validationError("recurringItems", `固定設定IDが重複しています: ${item.id}`);
    recurringIds.add(item.id);
  });

  const versionsRaw = sourceVersion === 1 ? [] : raw.recurringRuleVersions;
  const adjustmentsRaw = sourceVersion === 1 ? [] : raw.recurringAdjustments;
  if (!Array.isArray(versionsRaw)) validationError("recurringRuleVersions", "変更履歴が配列ではありません");
  if (!Array.isArray(adjustmentsRaw)) validationError("recurringAdjustments", "個別変更が配列ではありません");

  const recurringRuleVersions = dedupeLatest(versionsRaw.map((entry, index) => {
    const path = `recurringRuleVersions[${index}]`;
    if (!isPlainObject(entry) || !isValidId(entry.recurringId)) validationError(path, "固定設定IDが不正です");
    if (!recurringIds.has(entry.recurringId)) validationError(path, "元の固定設定がありません");
    if (!isValidMonth(entry.effectiveMonth)) validationError(`${path}.effectiveMonth`, "適用開始月が不正です");
    const rule = normalizeRecurringRule(entry.rule, `${path}.rule`);
    if (rule.id !== entry.recurringId) validationError(`${path}.rule.id`, "固定設定IDが一致しません");
    return { recurringId: entry.recurringId, effectiveMonth: entry.effectiveMonth, rule };
  }), entry => `${entry.recurringId}|${entry.effectiveMonth}`);

  const recurringAdjustments = dedupeLatest(adjustmentsRaw.map((entry, index) => {
    const path = `recurringAdjustments[${index}]`;
    if (!isPlainObject(entry) || !isValidId(entry.recurringId)) validationError(path, "固定設定IDが不正です");
    if (!recurringIds.has(entry.recurringId)) validationError(path, "元の固定設定がありません");
    if (!isValidMonth(entry.occurrenceMonth)) validationError(`${path}.occurrenceMonth`, "元の予定月が不正です");
    if (!["override", "skip"].includes(entry.action)) validationError(`${path}.action`, "操作が不正です");
    if (entry.action === "skip") return { recurringId: entry.recurringId, occurrenceMonth: entry.occurrenceMonth, action: "skip" };
    if (!isValidDate(entry.date)) validationError(`${path}.date`, "変更日が不正です");
    return {
      recurringId: entry.recurringId,
      occurrenceMonth: entry.occurrenceMonth,
      action: "override",
      date: entry.date,
      amount: requireAmount(entry.amount, `${path}.amount`),
      memo: requireText(entry.memo ?? "", `${path}.memo`, { allowEmpty: true })
    };
  }), entry => `${entry.recurringId}|${entry.occurrenceMonth}`);

  return { schemaVersion: SCHEMA_VERSION, settings, transactions, recurringItems, recurringRuleVersions, recurringAdjustments };
}

let storageProtectionError = "";
let rawStoredData = null;
let migrationNotice = "";

function loadData() {
  let stored;
  try { stored = localStorage.getItem(STORAGE_KEY); }
  catch (error) {
    storageProtectionError = `保存データへアクセスできません。${error.message}`;
    return getProtectedEmptyData();
  }
  if (stored === null) return getInitialData();
  rawStoredData = stored;
  try {
    const parsed = JSON.parse(stored);
    const data = normalizeData(parsed);
    if (parsed.schemaVersion == null || parsed.schemaVersion === 1) migrationNotice = "V1データを互換モードで読み込みました。次回保存時にV2形式になります。";
    return data;
  } catch (error) {
    console.warn("保存データを保護するため読み込みを停止しました。", error);
    storageProtectionError = `保存データの検証に失敗しました。既存データは変更していません。${error.message}`;
    return getProtectedEmptyData();
  }
}

let state = loadData();
let lastPersistedState = cloneData(state);
let lastSaveError = "";
let selectedMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let toastTimer;

const elements = Object.fromEntries(
  [...document.querySelectorAll("[id]")].map(element => [element.id, element])
);

function saveData() {
  if (storageProtectionError) {
    state = cloneData(lastPersistedState);
    lastSaveError = "保存データの保護中のため変更を保存できません。先にバックアップを取得してください。";
    showToast("保存を停止しました");
    return false;
  }
  try {
    const validated = normalizeData(state);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(validated));
    state = validated;
    lastPersistedState = cloneData(validated);
    rawStoredData = JSON.stringify(validated);
    migrationNotice = "";
    lastSaveError = "";
    elements.importBackupConfirmed.checked = false;
    elements.saveStatus.textContent = "保存しました";
    setTimeout(() => { elements.saveStatus.textContent = "端末内に保存"; }, 1200);
    return true;
  } catch (error) {
    state = cloneData(lastPersistedState);
    lastSaveError = `保存に失敗したため変更を取り消しました。${error.message}`;
    console.error("保存に失敗しました。", error);
    showToast("保存に失敗しました");
    return false;
  }
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

function resolveRecurringRule(data, recurringId, targetMonth) {
  const base = data.recurringItems.find(item => item.id === recurringId);
  if (!base) return null;
  let resolved = base;
  let latestMonth = "";
  data.recurringRuleVersions.forEach(version => {
    if (version.recurringId === recurringId && version.effectiveMonth <= targetMonth && version.effectiveMonth >= latestMonth) {
      resolved = version.rule;
      latestMonth = version.effectiveMonth;
    }
  });
  return cloneData(resolved);
}

function upsertRecurringRuleVersion(data, recurringId, effectiveMonth, rule) {
  const entry = { recurringId, effectiveMonth, rule: cloneData(rule) };
  const index = data.recurringRuleVersions.findIndex(item =>
    item.recurringId === recurringId && item.effectiveMonth === effectiveMonth
  );
  if (index >= 0) data.recurringRuleVersions[index] = entry;
  else data.recurringRuleVersions.push(entry);
}

function upsertRecurringAdjustment(data, adjustment) {
  const index = data.recurringAdjustments.findIndex(item =>
    item.recurringId === adjustment.recurringId && item.occurrenceMonth === adjustment.occurrenceMonth
  );
  if (index >= 0) data.recurringAdjustments[index] = cloneData(adjustment);
  else data.recurringAdjustments.push(cloneData(adjustment));
}

function removeRecurringAdjustment(data, recurringId, occurrenceMonth) {
  const previousLength = data.recurringAdjustments.length;
  data.recurringAdjustments = data.recurringAdjustments.filter(item =>
    item.recurringId !== recurringId || item.occurrenceMonth !== occurrenceMonth
  );
  return data.recurringAdjustments.length !== previousLength;
}

function shouldGenerate(item, targetDate) {
  if (!item.enabled) return false;
  const month = targetDate.getMonth() + 1;
  if (item.repeatType === "monthly") return true;
  if (item.repeatType === "bimonthly") return month % 2 === 0;
  return item.months.includes(month);
}

function scheduledDateForRule(rule, occurrenceMonth) {
  const target = parseDate(`${occurrenceMonth}-01`);
  const lastDay = endOfMonth(target).getDate();
  const day = rule.dayType === "end" ? lastDay : Math.min(rule.day, lastDay);
  return dateKey(new Date(target.getFullYear(), target.getMonth(), day));
}

function buildScheduledOccurrence(data, recurringId, occurrenceMonth) {
  const rule = resolveRecurringRule(data, recurringId, occurrenceMonth);
  if (!rule) return null;
  const target = parseDate(`${occurrenceMonth}-01`);
  if (!shouldGenerate(rule, target)) return null;
  return {
    id: `virtual_${recurringId}_${occurrenceMonth}`,
    date: scheduledDateForRule(rule, occurrenceMonth),
    type: rule.type,
    title: rule.title,
    amount: rule.amount,
    status: "planned",
    memo: rule.memo,
    recurringId,
    generatedMonth: occurrenceMonth,
    occurrenceMonth,
    isVirtual: true,
    isAdjusted: false
  };
}

function buildRecurringOccurrence(data, recurringId, occurrenceMonth) {
  const occurrence = buildScheduledOccurrence(data, recurringId, occurrenceMonth);
  if (!occurrence) return null;
  const adjustment = data.recurringAdjustments.find(item =>
    item.recurringId === recurringId && item.occurrenceMonth === occurrenceMonth
  );
  if (adjustment?.action === "skip") return null;
  if (adjustment?.action !== "override") return occurrence;
  return {
    ...occurrence,
    date: adjustment.date,
    amount: adjustment.amount,
    memo: adjustment.memo ?? occurrence.memo,
    isAdjusted: true,
    adjustmentAction: "override"
  };
}

function occurrenceKey(recurringId, occurrenceMonth) {
  return `${recurringId}|${occurrenceMonth}`;
}

function hasSavedOccurrence(data, recurringId, occurrenceMonth, exceptTransactionId = null) {
  return data.transactions.some(item =>
    item.id !== exceptTransactionId && item.recurringId === recurringId && item.generatedMonth === occurrenceMonth
  );
}

function registerActualOccurrence(data, occurrence, values = {}) {
  const recurringId = occurrence.recurringId;
  const occurrenceMonth = occurrence.generatedMonth || occurrence.occurrenceMonth;
  if (!isValidId(recurringId) || !isValidMonth(occurrenceMonth)) throw new Error("固定予定の識別情報が不正です。");
  if (hasSavedOccurrence(data, recurringId, occurrenceMonth)) throw new Error("同じ固定予定は既に保存済みです。二重登録はできません。");
  const date = values.date ?? occurrence.date;
  const amount = values.amount ?? occurrence.amount;
  if (!isValidDate(date)) throw new Error("実績の日付が不正です。");
  requireAmount(amount, "amount");
  const transaction = {
    id: createId("tx"), date, type: occurrence.type, title: occurrence.title, amount,
    status: "actual", memo: requireText(values.memo ?? occurrence.memo ?? "", "memo", { allowEmpty: true }),
    recurringId, generatedMonth: occurrenceMonth
  };
  data.transactions.push(transaction);
  return transaction;
}

function linkTransactionToOccurrence(data, transactionId, recurringId, occurrenceMonth) {
  const transaction = data.transactions.find(item => item.id === transactionId);
  if (!transaction) throw new Error("紐付ける取引が見つかりません。");
  if (!data.recurringItems.some(item => item.id === recurringId) || !isValidMonth(occurrenceMonth)) {
    throw new Error("固定予定の識別情報が不正です。");
  }
  if (hasSavedOccurrence(data, recurringId, occurrenceMonth, transactionId)) {
    throw new Error("同じ固定予定に紐付いた保存済み取引が既にあります。");
  }
  transaction.recurringId = recurringId;
  transaction.generatedMonth = occurrenceMonth;
  return transaction;
}

function monthsBetween(startMonth, endMonth) {
  if (!isValidMonth(startMonth) || !isValidMonth(endMonth) || startMonth > endMonth) return [];
  const result = [];
  let cursor = parseDate(`${startMonth}-01`);
  const end = parseDate(`${endMonth}-01`);
  while (cursor <= end) {
    result.push(monthKey(cursor));
    cursor = addMonths(cursor, 1);
  }
  return result;
}

function buildForecastTransactions(targetDate, data = state) {
  const confirmedDate = data.settings.confirmedDate;
  const startMonth = confirmedDate ? confirmedDate.slice(0, 7) : monthKey(new Date());
  const targetMonth = monthKey(targetDate);
  const occurrenceMonths = new Set(monthsBetween(startMonth, targetMonth));
  data.recurringAdjustments.forEach(adjustment => {
    if (adjustment.action === "override" && adjustment.date > confirmedDate && parseDate(adjustment.date) <= targetDate) {
      occurrenceMonths.add(adjustment.occurrenceMonth);
    }
  });

  const savedOccurrenceKeys = new Set(
    data.transactions
      .filter(item => item.recurringId && item.generatedMonth)
      .map(item => `${item.recurringId}|${item.generatedMonth}`)
  );
  const virtualTransactions = [];
  data.recurringItems.forEach(base => {
    occurrenceMonths.forEach(occurrenceMonth => {
      const key = `${base.id}|${occurrenceMonth}`;
      if (savedOccurrenceKeys.has(key)) return;
      const occurrence = buildRecurringOccurrence(data, base.id, occurrenceMonth);
      if (occurrence) virtualTransactions.push(occurrence);
    });
  });

  const warnings = [];
  const duplicateSuspicions = [];
  virtualTransactions.forEach(virtual => {
    const suspectedItems = data.transactions.filter(item =>
      !item.recurringId && item.date === virtual.date && item.type === virtual.type &&
      item.title === virtual.title && item.amount === virtual.amount
    );
    suspectedItems.forEach(manualTransaction => {
      const message = `「${virtual.title}」(${virtual.date})は手入力取引との重複の可能性があります。自動では除外していません。`;
      duplicateSuspicions.push({ manualTransaction, virtualTransaction: virtual, message });
      warnings.push(message);
    });
  });
  return {
    transactions: [...data.transactions.map(item => ({ ...item, isVirtual: false })), ...virtualTransactions],
    virtualTransactions,
    warnings: [...new Set(warnings)],
    duplicateSuspicions
  };
}

function getTransactionItemsForMonth(monthDate, data = state) {
  const key = monthKey(monthDate);
  const built = buildForecastTransactions(endOfMonth(monthDate), data);
  const items = built.transactions.filter(item => item.date.startsWith(key));
  const savedKeys = new Set(
    data.transactions
      .filter(item => item.recurringId && item.generatedMonth)
      .map(item => occurrenceKey(item.recurringId, item.generatedMonth))
  );
  data.recurringAdjustments
    .filter(item => item.action === "skip" && item.occurrenceMonth === key)
    .forEach(adjustment => {
      if (savedKeys.has(occurrenceKey(adjustment.recurringId, adjustment.occurrenceMonth))) return;
      const scheduled = buildScheduledOccurrence(data, adjustment.recurringId, adjustment.occurrenceMonth);
      if (scheduled) items.push({ ...scheduled, isSkipped: true, adjustmentAction: "skip" });
    });
  items.sort((a, b) => a.date.localeCompare(b.date) || Number(a.isVirtual) - Number(b.isVirtual) || a.title.localeCompare(b.title, "ja"));
  return { items, warnings: built.warnings };
}

function savedTransactionRuleDifference(data, transaction, referenceDate = new Date()) {
  if (transaction.status !== "planned" || transaction.date < dateKey(referenceDate) || !transaction.recurringId || !transaction.generatedMonth) return "";
  const expected = buildScheduledOccurrence(data, transaction.recurringId, transaction.generatedMonth);
  if (!expected) return "現在の固定設定では、この発生月は対象外または無効です。保存済み予定は変更していません。";
  const differences = [];
  if (transaction.date !== expected.date) differences.push(`日付 ${formatDate(expected.date)}`);
  if (transaction.amount !== expected.amount) differences.push(`金額 ${formatYen(expected.amount)}`);
  if (transaction.type !== expected.type || transaction.title !== expected.title) differences.push("内容・種別");
  return differences.length ? `現在の固定設定（${differences.join("、")}）と異なります。保存済み予定を優先しています。` : "";
}

function forecastTransactionSource(item) {
  if (item.isVirtual && item.isAdjusted) return "個別変更";
  if (item.isVirtual) return "自動予定";
  return "保存済み取引";
}

function compareForecastTransactions(a, b) {
  return a.date.localeCompare(b.date) || Number(a.isVirtual) - Number(b.isVirtual) || a.title.localeCompare(b.title, "ja");
}

function nextDateKey(value) {
  const date = parseDate(value);
  date.setDate(date.getDate() + 1);
  return dateKey(date);
}

function buildForecastBreakdown(targetDate, data, built, includedTransactions, forecastBalance) {
  const endDate = dateKey(targetDate);
  if (!isBalanceConfigured(data)) {
    return {
      configured: false,
      confirmedDate: data.settings.confirmedDate || null,
      confirmedBalance: null,
      startDate: null,
      endDate,
      incomeTotal: null,
      expenseTotal: null,
      forecastBalance: null,
      transactions: [],
      excludedTransactions: [],
      duplicateSuspicions: []
    };
  }

  const confirmedDate = data.settings.confirmedDate;
  const ordered = [...includedTransactions].sort(compareForecastTransactions);
  let runningBalance = data.settings.confirmedBalance;
  const transactions = ordered.map(item => {
    runningBalance += signedAmount(item);
    return {
      ...item,
      source: forecastTransactionSource(item),
      occurrenceMonth: item.generatedMonth || item.occurrenceMonth || null,
      balanceAfter: runningBalance
    };
  });
  const incomeTotal = ordered.filter(item => item.type === "income").reduce((sum, item) => sum + item.amount, 0);
  const expenseTotal = ordered.filter(item => item.type === "expense").reduce((sum, item) => sum + item.amount, 0);
  const includedIds = new Set(ordered.map(item => item.id));
  const excludedTransactions = [];
  const excludedKeys = new Set();
  const addExcluded = (item, reasonCode, reason, source = forecastTransactionSource(item)) => {
    const key = `${item.id}|${reasonCode}`;
    if (includedIds.has(item.id) || excludedKeys.has(key)) return;
    excludedKeys.add(key);
    excludedTransactions.push({
      ...item,
      source,
      occurrenceMonth: item.generatedMonth || item.occurrenceMonth || null,
      reasonCode,
      reason
    });
  };

  built.transactions.forEach(item => {
    if (includedIds.has(item.id)) return;
    if (item.date < confirmedDate) addExcluded(item, "before-confirmed", "通帳確認日以前");
    else if (item.date === confirmedDate) addExcluded(item, "on-confirmed", "通帳確認日当日");
    else if (parseDate(item.date) > targetDate) addExcluded(item, "after-target", "予測対象日より後");
  });

  const startMonth = confirmedDate.slice(0, 7);
  const targetMonth = monthKey(targetDate);
  const occurrenceMonths = new Set(monthsBetween(startMonth, targetMonth));
  data.recurringAdjustments.forEach(adjustment => {
    if (adjustment.action === "override" && adjustment.date > confirmedDate && parseDate(adjustment.date) <= targetDate) {
      occurrenceMonths.add(adjustment.occurrenceMonth);
    }
  });
  const savedByOccurrence = new Map(
    data.transactions
      .filter(item => item.recurringId && item.generatedMonth)
      .map(item => [occurrenceKey(item.recurringId, item.generatedMonth), item])
  );
  data.recurringItems.forEach(base => {
    occurrenceMonths.forEach(occurrenceMonth => {
      const rule = resolveRecurringRule(data, base.id, occurrenceMonth);
      if (!rule) return;
      const scheduled = {
        id: `virtual_${base.id}_${occurrenceMonth}`,
        date: scheduledDateForRule(rule, occurrenceMonth),
        type: rule.type,
        title: rule.title,
        amount: rule.amount,
        status: "planned",
        memo: rule.memo,
        recurringId: base.id,
        generatedMonth: occurrenceMonth,
        occurrenceMonth,
        isVirtual: true,
        isAdjusted: false
      };
      if (!rule.enabled) {
        addExcluded(scheduled, "disabled-rule", "対象月の固定設定が無効");
        return;
      }
      if (!shouldGenerate(rule, parseDate(`${occurrenceMonth}-01`))) {
        addExcluded(scheduled, "repeat-not-matched", "繰り返し条件に該当しない");
        return;
      }
      const key = occurrenceKey(base.id, occurrenceMonth);
      if (savedByOccurrence.has(key)) {
        addExcluded(scheduled, "saved-priority", "同じ発生分の保存済み取引が優先された");
        return;
      }
      const adjustment = data.recurringAdjustments.find(item =>
        item.recurringId === base.id && item.occurrenceMonth === occurrenceMonth
      );
      if (adjustment?.action === "skip") addExcluded(scheduled, "one-time-skip", "今回だけスキップ");
    });
  });

  excludedTransactions.sort(compareForecastTransactions);
  const duplicateSuspicions = built.duplicateSuspicions.filter(suspicion =>
    includedIds.has(suspicion.manualTransaction.id) && includedIds.has(suspicion.virtualTransaction.id)
  );
  return {
    configured: true,
    confirmedDate,
    confirmedBalance: data.settings.confirmedBalance,
    startDate: nextDateKey(confirmedDate),
    endDate,
    incomeTotal,
    expenseTotal,
    forecastBalance,
    transactions,
    excludedTransactions,
    duplicateSuspicions
  };
}

function calculateForecastSummary(targetDate, data = state) {
  const built = buildForecastTransactions(targetDate, data);
  if (!isBalanceConfigured(data)) {
    const breakdown = buildForecastBreakdown(targetDate, data, built, [], null);
    return { balance: null, minimumBalance: null, minimumDate: null, dailyAmounts: new Map(), includedTransactions: [], breakdown, ...built };
  }
  const confirmedDate = data.settings.confirmedDate;
  const dailyAmounts = new Map();
  const includedTransactions = built.transactions
    .filter(item => item.date > confirmedDate && parseDate(item.date) <= targetDate);
  includedTransactions
    .forEach(item => dailyAmounts.set(item.date, (dailyAmounts.get(item.date) || 0) + signedAmount(item)));
  let balance = data.settings.confirmedBalance;
  let minimumBalance = balance;
  let minimumDate = confirmedDate || null;
  [...dailyAmounts.entries()].sort(([dateA], [dateB]) => dateA.localeCompare(dateB)).forEach(([date, amount]) => {
    balance += amount;
    if (balance < minimumBalance) {
      minimumBalance = balance;
      minimumDate = date;
    }
  });
  const breakdown = buildForecastBreakdown(targetDate, data, built, includedTransactions, balance);
  return { balance, minimumBalance, minimumDate, dailyAmounts, includedTransactions, breakdown, ...built };
}

function forecastAt(targetDate, data = state) {
  return calculateForecastSummary(targetDate, data).balance;
}

function getFourForecastPoints(referenceDate = new Date(), data = state) {
  return [0, 1, 2, 3].map(offset => {
    const targetDate = endOfMonth(addMonths(referenceDate, offset));
    return { offset, targetDate, ...calculateForecastSummary(targetDate, data) };
  });
}

function forecastStatus(balance) {
  if (balance === null) return { text: "残高と確認日を設定してください", className: "" };
  if (balance < 0) return { text: "残高不足の見込み", className: "danger" };
  if (balance < state.settings.alertThreshold) return { text: "警告基準額を下回ります", className: "warning" };
  return { text: "基準額以上", className: "" };
}

function getConfirmedAgeInfo(confirmedDate, referenceDate = new Date()) {
  if (!confirmedDate || !isValidDate(confirmedDate)) return { days: null, label: "未確認", stale: true };
  const confirmed = parseDate(confirmedDate);
  const confirmedUtc = Date.UTC(confirmed.getFullYear(), confirmed.getMonth(), confirmed.getDate());
  const referenceUtc = Date.UTC(referenceDate.getFullYear(), referenceDate.getMonth(), referenceDate.getDate());
  const days = Math.floor((referenceUtc - confirmedUtc) / 86400000);
  if (days < 0) return { days, label: "確認日を確認", stale: true };
  if (days === 0) return { days, label: "本日確認", stale: false };
  return { days, label: `${days}日前`, stale: days >= BALANCE_REVIEW_DAYS };
}

function transactionDisplayStatus(item) {
  if (item.isSkipped) return { label: "スキップ済み", className: "skipped" };
  if (item.isVirtual && item.isAdjusted) return { label: "今回だけ変更済み", className: "adjusted" };
  if (item.isVirtual) return { label: "自動予定", className: "auto" };
  if (item.status === "actual") return { label: "実績", className: "actual" };
  return { label: "予定", className: "" };
}

function getHomeViewModel(referenceDate = new Date(), data = state) {
  const today = dateKey(referenceDate);
  const points = getFourForecastPoints(referenceDate, data);
  const horizon = points[3].targetDate;
  const age = getConfirmedAgeInfo(data.settings.confirmedDate, referenceDate);
  const upcoming = points[3].transactions
    .filter(item => item.status === "planned" && item.date >= today && parseDate(item.date) <= horizon)
    .sort((a, b) => a.date.localeCompare(b.date) || Number(a.isVirtual) - Number(b.isVirtual) || a.title.localeCompare(b.title, "ja"))
    .slice(0, HOME_UPCOMING_LIMIT);
  const overdue = points[3].transactions
    .filter(item => item.status === "planned" && item.date > data.settings.confirmedDate && item.date < today)
    .sort((a, b) => a.date.localeCompare(b.date));
  const suspectedManual = data.transactions.filter(transaction =>
    !transaction.recurringId && points[3].virtualTransactions.some(virtual =>
      virtual.date === transaction.date && virtual.type === transaction.type &&
      virtual.title === transaction.title && virtual.amount === transaction.amount
    )
  );
  const differentSaved = data.transactions
    .map(item => ({ item, message: savedTransactionRuleDifference(data, item, referenceDate) }))
    .filter(entry => entry.message);
  const attention = [];
  if (age.stale) {
    attention.push({
      kind: "balance",
      title: age.days === null ? "通帳残高がまだ確認されていません" : age.days < 0 ? "残高の確認日が未来の日付です" : `残高確認から${age.days}日経過しています`,
      detail: "通帳を確認した日と残高を更新してください。",
      action: "balance"
    });
  }
  if (overdue.length) {
    attention.push({
      kind: "overdue",
      title: `過去日の未実績予定が${overdue.length}件あります`,
      detail: `最も古い予定：${formatDate(overdue[0].date)} ${overdue[0].title}`,
      month: overdue[0].date.slice(0, 7)
    });
  }
  if (suspectedManual.length) {
    attention.push({
      kind: "duplicate",
      title: `固定予定との重複疑いが${suspectedManual.length}件あります`,
      detail: "自動では統合していません。入出金一覧で確認してください。",
      month: suspectedManual[0].date.slice(0, 7)
    });
  }
  if (differentSaved.length) {
    attention.push({
      kind: "difference",
      title: `固定設定と異なる保存済み予定が${differentSaved.length}件あります`,
      detail: differentSaved[0].message,
      month: differentSaved[0].item.date.slice(0, 7)
    });
  }
  return { today, points, age, upcoming, attention, overdue, suspectedManual, differentSaved };
}

function getHomePredictionAlerts(view, data = state) {
  if (!isBalanceConfigured(data)) return [];
  const negative = view.points.find(point => point.balance < 0);
  const low = view.points.find(point => point.balance < data.settings.alertThreshold);
  const minimum = view.points[3];
  const alerts = [];
  if (negative) {
    alerts.push({ className: "danger", title: "残高不足の予測があります", detail: `${formatYen(negative.balance)}まで下がる見込みです。入金予定や費用をご確認ください。` });
  } else if (low) {
    alerts.push({ className: "warning", title: "残高が警告基準額を下回る見込みです", detail: `設定中の基準額は${formatYen(data.settings.alertThreshold)}です。` });
  }
  const minimumMatchesEndpoint = negative && minimum.minimumDate === dateKey(negative.targetDate) && minimum.minimumBalance === negative.balance;
  if (minimum.minimumBalance < 0 && !minimumMatchesEndpoint) {
    alerts.push({ className: "danger", title: "月の途中で一時的な残高不足があります", detail: `${formatDate(minimum.minimumDate)}の日次取引反映後に${formatYen(minimum.minimumBalance)}となる見込みです。` });
  } else if (!low && minimum.minimumBalance < data.settings.alertThreshold) {
    alerts.push({ className: "warning", title: "月の途中で警告基準額を下回ります", detail: `${formatDate(minimum.minimumDate)}の日次取引反映後に${formatYen(minimum.minimumBalance)}となる見込みです。` });
  }
  return alerts;
}

function getHomeTransactionAction(item) {
  if (item.isVirtual) {
    return { kind: "virtual", recurringId: item.recurringId, occurrenceMonth: item.generatedMonth || item.occurrenceMonth };
  }
  return { kind: "saved", id: item.id };
}

function breakdownItemHtml(item, { excluded = false } = {}) {
  const status = item.status === "actual" ? "実績" : "予定";
  const occurrence = item.occurrenceMonth ? `発生月 ${escapeHtml(item.occurrenceMonth)}` : "発生月なし";
  const recurring = item.recurringId ? `recurringId ${escapeHtml(item.recurringId)}` : "手入力・単発";
  return `<article class="breakdown-item">
    <div class="breakdown-item-head">
      <span class="breakdown-item-date">${escapeHtml(formatDate(item.date))}</span>
      <span class="breakdown-item-title">${escapeHtml(item.title)}</span>
      <span class="breakdown-item-amount ${item.type === "income" ? "income-text" : "expense-text"}">${item.type === "income" ? "+" : "-"}${formatYen(item.amount)}</span>
    </div>
    <div class="breakdown-item-meta"><span>${item.type === "income" ? "入金" : "出金"}</span><span>${status}</span><span>${escapeHtml(item.source)}</span><span>${recurring}</span><span>${occurrence}</span></div>
    ${excluded ? `<div class="breakdown-reason">対象外：${escapeHtml(item.reason)}</div>` : `<div class="breakdown-item-balance">反映後 ${formatYen(item.balanceAfter)}</div>`}
  </article>`;
}

function renderForecastBreakdown(summary) {
  const breakdown = summary.breakdown;
  const targetDate = summary.targetDate || parseDate(breakdown.endDate);
  elements.forecastBreakdownTitle.textContent = `${targetDate.getFullYear()}年${targetDate.getMonth() + 1}月末の計算内訳`;
  if (!breakdown.configured) {
    elements.forecastBreakdownContent.innerHTML = `<div class="breakdown-unavailable">通帳で確認した残高と確認日を設定すると、計算内訳を確認できます。</div>`;
    return;
  }
  const warnings = breakdown.duplicateSuspicions.length
    ? `<div class="breakdown-warning"><strong>重複している可能性がある取引があります</strong>${breakdown.duplicateSuspicions.map(suspicion =>
      `<span>${escapeHtml(formatDate(suspicion.manualTransaction.date))} ${escapeHtml(suspicion.manualTransaction.title)} ${formatYen(suspicion.manualTransaction.amount)}：手入力取引（ID ${escapeHtml(suspicion.manualTransaction.id)}）と自動予定（${escapeHtml(suspicion.virtualTransaction.recurringId)} / ${escapeHtml(suspicion.virtualTransaction.generatedMonth)}）を両方計上しています。自動では削除・統合していません。</span>`
    ).join("")}</div>`
    : "";
  const transactionList = breakdown.transactions.length
    ? breakdown.transactions.map(item => breakdownItemHtml(item)).join("")
    : `<div class="breakdown-empty">この期間に採用した入出金はありません。</div>`;
  const excludedList = breakdown.excludedTransactions.length
    ? breakdown.excludedTransactions.map(item => breakdownItemHtml(item, { excluded: true })).join("")
    : `<div class="breakdown-empty">確認できる対象外取引はありません。</div>`;
  elements.forecastBreakdownContent.innerHTML = `
    <p class="breakdown-period">通帳確認日 ${formatDate(breakdown.confirmedDate)} ／ 計算期間 ${formatDate(breakdown.startDate)} ～ ${formatDate(breakdown.endDate)}</p>
    <div class="breakdown-formula">
      <div><span>確認済み残高</span><strong>${formatYen(breakdown.confirmedBalance)}</strong></div>
      <div><span>採用入金</span><strong class="income-text">+${formatYen(breakdown.incomeTotal)}</strong></div>
      <div><span>採用出金</span><strong class="expense-text">-${formatYen(breakdown.expenseTotal)}</strong></div>
      <div><span>予測残高</span><strong>${formatYen(breakdown.forecastBalance)}</strong></div>
    </div>
    <p class="breakdown-equation">予測残高 ＝ 確認済み残高 ＋ 採用入金 － 採用出金</p>
    ${warnings}
    <section class="breakdown-section"><h3>採用した入出金（${breakdown.transactions.length}件）</h3><div class="breakdown-list">${transactionList}</div></section>
    <details class="breakdown-excluded"><summary>計算対象外の取引（${breakdown.excludedTransactions.length}件）</summary><div class="breakdown-list">${excludedList}</div></details>`;
}

function openForecastBreakdown(offset, referenceDate = new Date(), data = state) {
  const targetDate = endOfMonth(addMonths(referenceDate, offset));
  const summary = { targetDate, ...calculateForecastSummary(targetDate, data) };
  renderForecastBreakdown(summary);
  elements.forecastBreakdownDialog.showModal();
  return summary;
}

function renderHome() {
  const now = new Date();
  const view = getHomeViewModel(now);
  const { points } = view;
  const forecasts = [
    [elements.forecastCurrent, elements.forecastCurrentStatus, points[0]],
    [elements.forecastNext, elements.forecastNextStatus, points[1]],
    [elements.forecastTwoMonths, elements.forecastTwoStatus, points[2]],
    [elements.forecastThreeMonths, elements.forecastThreeStatus, points[3]]
  ];
  [elements.forecastCurrentLabel, elements.forecastNextLabel, elements.forecastTwoMonthsLabel, elements.forecastThreeMonthsLabel]
    .forEach((label, index) => {
      const date = points[index].targetDate;
      label.textContent = `${date.getFullYear()}年${date.getMonth() + 1}月末`;
    });

  const configured = isBalanceConfigured();
  const protectedStorage = Boolean(storageProtectionError);
  elements.accountTitle.textContent = state.settings.accountLabel;
  elements.setupCard.classList.toggle("hidden", configured || protectedStorage);
  elements.storageRecoveryCard.classList.toggle("hidden", !protectedStorage);
  elements.storageRecoveryMessage.textContent = storageProtectionError;
  elements.openBalanceModal.disabled = protectedStorage;
  elements.startSetupButton.disabled = protectedStorage;
  elements.resetButton.disabled = protectedStorage;
  elements.addTransactionButton.disabled = protectedStorage || !configured;
  elements.addRecurringButton.disabled = protectedStorage || !configured;
  elements.confirmedBalance.textContent = protectedStorage ? "読み込み停止" : state.settings.confirmedBalance === null ? "未設定" : formatYen(state.settings.confirmedBalance);
  elements.confirmedDate.textContent = state.settings.confirmedDate ? formatDate(state.settings.confirmedDate) : "未設定";
  elements.confirmedAge.textContent = state.settings.confirmedDate ? view.age.label : "未設定";
  elements.saveStatus.textContent = protectedStorage ? "保存保護中" : rawStoredData === null ? "未設定" : "端末内に保存";

  forecasts.forEach(([amountElement, statusElement, point]) => {
    const status = forecastStatus(point.balance);
    amountElement.textContent = point.balance === null ? "未設定" : formatYen(point.balance);
    statusElement.textContent = status.text;
    amountElement.closest(".forecast-card").className = `forecast-card${status.className ? ` ${status.className}` : ""}`;
  });

  const alerts = [];
  if (lastSaveError) alerts.push(`<div class="alert-card danger">変更は保存されていません<p>${escapeHtml(lastSaveError)}</p></div>`);
  if (migrationNotice) alerts.push(`<div class="alert-card warning">旧データを安全に読み込みました<p>${escapeHtml(migrationNotice)}</p></div>`);
  getHomePredictionAlerts(view).forEach(alert => alerts.push(`<div class="alert-card ${alert.className}">${escapeHtml(alert.title)}<p>${escapeHtml(alert.detail)}</p></div>`));
  elements.alertArea.innerHTML = alerts.join("");

  elements.homeUpcomingList.innerHTML = view.upcoming.length ? view.upcoming.map(item => {
    const date = parseDate(item.date);
    const status = transactionDisplayStatus(item);
    const action = getHomeTransactionAction(item);
    const actionAttributes = action.kind === "virtual"
      ? `data-home-action="virtual" data-recurring-id="${action.recurringId}" data-occurrence-month="${action.occurrenceMonth}"`
      : `data-home-action="saved" data-id="${action.id}"`;
    const homeLabel = item.isVirtual ? status.label : "保存済み予定";
    return `<button type="button" class="home-upcoming-item${item.isVirtual ? " virtual" : ""}" ${actionAttributes}>
      <span class="home-upcoming-date">${date.getMonth() + 1}月<strong>${date.getDate()}</strong>日</span>
      <span class="home-upcoming-content"><span class="home-upcoming-title">${escapeHtml(item.title)}</span><span class="home-upcoming-meta"><span class="status-badge ${status.className}">${homeLabel}</span><span>${item.type === "income" ? "入金" : "出金"}</span></span></span>
      <span class="home-upcoming-amount ${item.type === "income" ? "income-text" : "expense-text"}">${item.type === "income" ? "+" : "-"}${formatYen(item.amount)}</span>
    </button>`;
  }).join("") : `<div class="home-upcoming-empty">3か月後までの予定はありません。</div>`;

  elements.homeAttentionSection.classList.toggle("hidden", !view.attention.length || !configured || protectedStorage);
  elements.homeAttentionList.innerHTML = view.attention.map(item => `<article class="home-attention-item${item.kind === "overdue" ? " danger" : ""}">
    <strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.detail)}</span>
    ${item.action === "balance" ? `<button type="button" class="mini-button" data-home-attention-action="balance">残高を更新する</button>` : `<button type="button" class="mini-button" data-home-attention-month="${item.month}">入出金一覧で確認</button>`}
  </article>`).join("");

  const currentKey = monthKey(now);
  const monthTransactions = points[0].transactions.filter(item => item.date.startsWith(currentKey));
  const income = monthTransactions.filter(item => item.type === "income").reduce((sum, item) => sum + item.amount, 0);
  const expense = monthTransactions.filter(item => item.type === "expense").reduce((sum, item) => sum + item.amount, 0);
  const futureMonthTransactions = configured
    ? monthTransactions.filter(item => item.date > state.settings.confirmedDate)
    : [];
  const futureIncome = futureMonthTransactions.filter(item => item.type === "income").reduce((sum, item) => sum + item.amount, 0);
  const futureExpense = futureMonthTransactions.filter(item => item.type === "expense").reduce((sum, item) => sum + item.amount, 0);
  elements.monthIncome.textContent = `+${formatYen(income)}`;
  elements.monthExpense.textContent = `-${formatYen(expense)}`;
  elements.monthFutureIncome.textContent = configured ? `+${formatYen(futureIncome)}` : "未設定";
  elements.monthFutureExpense.textContent = configured ? `-${formatYen(futureExpense)}` : "未設定";
}

function renderTransactions() {
  const key = monthKey(selectedMonth);
  const { items } = getTransactionItemsForMonth(selectedMonth);
  elements.selectedMonthLabel.textContent = `${selectedMonth.getFullYear()}年 ${selectedMonth.getMonth() + 1}月`;
  const net = items.filter(item => !item.isSkipped).reduce((sum, item) => sum + signedAmount(item), 0);
  elements.monthTotal.innerHTML = `月全体の収支 <strong class="${net >= 0 ? "income-text" : "expense-text"}">${net >= 0 ? "+" : ""}${formatYen(net)}</strong>`;
  if (isBalanceConfigured()) {
    const forecastNet = items
      .filter(item => !item.isSkipped && item.date > state.settings.confirmedDate)
      .reduce((sum, item) => sum + signedAmount(item), 0);
    elements.monthTotalScope.innerHTML = `通帳確認日より後：<strong class="${forecastNet >= 0 ? "income-text" : "expense-text"}">${forecastNet >= 0 ? "+" : ""}${formatYen(forecastNet)}</strong><br>月全体には確認日以前・当日の入出金も含み、予測残高とは集計期間が異なります。`;
  } else {
    elements.monthTotalScope.textContent = "月全体には通帳確認日以前・当日の入出金も含みます。残高と確認日を設定すると、予測期間分も表示します。";
  }

  if (!items.length) {
    elements.transactionList.innerHTML = `<div class="empty-state">この月の入出金予定はありません。<br>固定設定を追加すると自動で表示されます。</div>`;
    return;
  }
  elements.transactionList.innerHTML = items.map(item => {
    const date = parseDate(item.date);
    const occurrenceMonth = item.generatedMonth || item.occurrenceMonth;
    const virtualAttributes = item.isVirtual && !item.isSkipped
      ? ` data-action="virtual-edit" data-recurring-id="${item.recurringId}" data-occurrence-month="${occurrenceMonth}"`
      : "";
    const status = transactionDisplayStatus(item);
    let actions;
    if (item.isSkipped) {
      actions = `<button class="mini-button" data-action="adjustment-clear" data-recurring-id="${item.recurringId}" data-occurrence-month="${occurrenceMonth}">スキップを取り消す</button>`;
    } else if (item.isVirtual) {
      actions = `
        <button class="mini-button" data-action="virtual-edit" data-recurring-id="${item.recurringId}" data-occurrence-month="${occurrenceMonth}">今回だけ変更</button>
        <button class="mini-button" data-action="virtual-actual" data-recurring-id="${item.recurringId}" data-occurrence-month="${occurrenceMonth}">実績にする</button>
        ${item.isAdjusted ? `<button class="mini-button" data-action="adjustment-clear" data-recurring-id="${item.recurringId}" data-occurrence-month="${occurrenceMonth}">変更を取り消す</button>` : ""}
        <button class="mini-button delete" data-action="virtual-skip" data-recurring-id="${item.recurringId}" data-occurrence-month="${occurrenceMonth}">今回だけスキップ</button>`;
    } else {
      actions = `
        ${item.status === "planned" ? `<button class="mini-button" data-action="actual" data-id="${item.id}">実績にする</button>` : ""}
        <button class="mini-button" data-action="edit" data-id="${item.id}">編集</button>
        <button class="mini-button delete" data-action="delete" data-id="${item.id}">取引を削除</button>`;
    }
    const ruleDifference = savedTransactionRuleDifference(state, item);
    const matchCandidates = item.isVirtual || item.recurringId ? [] : items.filter(candidate =>
      candidate.isVirtual && !candidate.isSkipped && candidate.date === item.date && candidate.type === item.type &&
      candidate.title === item.title && candidate.amount === item.amount
    );
    const duplicateWarning = matchCandidates.length === 1
      ? `<div class="item-warning">固定予定との重複の可能性があります。自動では統合していません。<br><button class="mini-button" data-action="link-recurring" data-id="${item.id}" data-recurring-id="${matchCandidates[0].recurringId}" data-occurrence-month="${matchCandidates[0].generatedMonth}">この固定予定に紐付ける</button></div>`
      : matchCandidates.length > 1
        ? `<div class="item-warning">一致する固定予定が複数あるため、自動で候補を決定できません。</div>`
        : "";
    return `
      <article class="transaction-item${item.isVirtual ? " virtual" : ""}${item.isSkipped ? " skipped" : ""}"${virtualAttributes}>
        <div class="transaction-main">
          <div class="date-box">${date.getMonth() + 1}月<strong>${date.getDate()}</strong>日</div>
          <div>
            <div class="transaction-title">${escapeHtml(item.title)}</div>
            <div class="transaction-meta"><span class="status-badge ${status.className}">${status.label}</span>${item.memo ? ` ・ ${escapeHtml(item.memo)}` : ""}</div>
          </div>
          <div class="amount ${item.type === "income" ? "income-text" : "expense-text"}">${item.type === "income" ? "+" : "-"}${formatYen(item.amount)}</div>
        </div>
        ${ruleDifference ? `<div class="item-warning">${escapeHtml(ruleDifference)}</div>` : ""}
        ${duplicateWarning}
        <div class="item-actions">${actions}</div>
      </article>`;
  }).join("");
}

function repeatLabel(item) {
  if (item.repeatType === "monthly") return "毎月";
  if (item.repeatType === "bimonthly") return "2か月ごと（偶数月）";
  return `${item.months.join("・") || "未指定"}月`;
}

function renderRecurring() {
  const effectiveMonth = currentJapanMonth();
  const items = state.recurringItems
    .map(item => resolveRecurringRule(state, item.id, effectiveMonth))
    .filter(Boolean)
    .sort((a, b) => Number(b.enabled) - Number(a.enabled));
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

function getEditableOccurrence(recurringId, occurrenceMonth) {
  if (hasSavedOccurrence(state, recurringId, occurrenceMonth)) throw new Error("この固定予定は既に保存済みです。");
  const occurrence = buildRecurringOccurrence(state, recurringId, occurrenceMonth);
  if (!occurrence) throw new Error("対象の自動予定が見つかりません。");
  return occurrence;
}

function updateOccurrenceForecastNote() {
  const date = elements.occurrenceDate.value;
  elements.occurrenceForecastNote.textContent = date && state.settings.confirmedDate && date <= state.settings.confirmedDate
    ? `確認済み残高の基準日（${formatDate(state.settings.confirmedDate)}）以前のため、実績登録しても残高予測には再計上されません。`
    : "この変更は今回の発生分だけに適用されます。固定設定や他の月は変更しません。";
}

function openOccurrenceDialog(recurringId, occurrenceMonth, { actual = false } = {}) {
  try {
    const occurrence = getEditableOccurrence(recurringId, occurrenceMonth);
    const adjustment = state.recurringAdjustments.find(item =>
      item.recurringId === recurringId && item.occurrenceMonth === occurrenceMonth && item.action === "override"
    );
    elements.occurrenceRecurringId.value = recurringId;
    elements.occurrenceMonth.value = occurrenceMonth;
    elements.occurrenceTitle.textContent = occurrence.title;
    elements.occurrenceTypeLabel.textContent = occurrence.type === "income" ? "入" : "出";
    elements.occurrenceSourceLabel.textContent = occurrence.isAdjusted ? "今回だけ変更済み" : "自動予定";
    elements.occurrenceDate.value = occurrence.date;
    elements.occurrenceAmount.value = occurrence.amount;
    elements.occurrenceMemo.value = occurrence.memo || "";
    elements.occurrenceDialogTitle.textContent = actual ? "実績として登録" : "今回の予定を変更";
    elements.occurrenceDialog.dataset.mode = actual ? "actual" : "adjust";
    elements.occurrenceOverrideButton.classList.toggle("hidden", actual);
    elements.occurrenceActualButton.textContent = actual ? "この内容で実績登録" : "実績として登録";
    elements.occurrenceResetButton.classList.toggle("hidden", !adjustment);
    updateOccurrenceForecastNote();
    elements.occurrenceDialog.showModal();
  } catch (error) {
    window.alert(error.message);
    renderAll();
  }
}

function openRecurring(item = null) {
  elements.recurringDialogTitle.textContent = item ? "今後の固定設定を変更" : "固定入出金を追加";
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
  const effectiveMonth = currentJapanMonth();
  elements.recurringEffectiveMonthHelp.textContent = `適用開始：${effectiveMonth.replace("-", "年")}月。これは今後の固定設定の変更です。「今回だけ変更」ではありません。過去と保存済み取引は変更しません。`;
  updateRecurringFields();
  elements.recurringDialog.showModal();
}

function updateRecurringFields() {
  elements.recurringDayLabel.classList.toggle("hidden", elements.recurringDayType.value === "end");
  elements.monthsField.classList.toggle("hidden", elements.recurringRepeatType.value !== "specified");
}

function confirmDelete(message) {
  return window.confirm(message);
}

document.querySelectorAll("[data-nav]").forEach(button => button.addEventListener("click", () => navigate(button.dataset.nav)));
document.querySelectorAll("[data-nav-target]").forEach(button => button.addEventListener("click", () => navigate(button.dataset.navTarget)));
document.querySelectorAll("[data-home-forecast-offset]").forEach(button => button.addEventListener("click", () => {
  selectedMonth = addMonths(new Date(), Number(button.dataset.homeForecastOffset));
  navigate("transactions");
}));
document.querySelectorAll("[data-forecast-breakdown-offset]").forEach(button => button.addEventListener("click", () => {
  openForecastBreakdown(Number(button.dataset.forecastBreakdownOffset));
}));
elements.homeUpcomingList.addEventListener("click", event => {
  const target = event.target.closest("[data-home-action]");
  if (!target) return;
  if (target.dataset.homeAction === "virtual") {
    openOccurrenceDialog(target.dataset.recurringId, target.dataset.occurrenceMonth);
    return;
  }
  const item = state.transactions.find(transaction => transaction.id === target.dataset.id);
  if (item) openTransaction(item);
});
elements.homeAttentionList.addEventListener("click", event => {
  const balanceButton = event.target.closest("[data-home-attention-action='balance']");
  if (balanceButton) {
    elements.openBalanceModal.click();
    return;
  }
  const monthButton = event.target.closest("[data-home-attention-month]");
  if (!monthButton) return;
  selectedMonth = parseDate(`${monthButton.dataset.homeAttentionMonth}-01`);
  navigate("transactions");
});

function openBalanceSetup() {
  if (storageProtectionError) { navigate("data"); return; }
  elements.accountLabelInput.value = state.settings.accountLabel;
  elements.balanceDateInput.value = state.settings.confirmedDate;
  elements.balanceAmountInput.value = state.settings.confirmedBalance ?? "";
  elements.balanceDialog.showModal();
}

function setAccountBalance(accountLabel, amount, confirmedDate) {
  if (storageProtectionError) throw new Error("保存データを保護しています。正常なJSONから復元してください。");
  if (!isValidDate(confirmedDate)) throw new Error("通帳で確認した日付を入力してください。");
  if (String(amount).trim() === "") throw new Error("確認した残高を入力してください。0円も登録できます。");
  const candidate = cloneData(state);
  candidate.settings.accountLabel = requireText(accountLabel.trim(), "口座名");
  candidate.settings.confirmedBalance = requireAmount(Number(amount), "残高", { allowZero: true });
  candidate.settings.confirmedDate = confirmedDate;
  state = normalizeData(candidate);
  return saveData();
}

elements.openBalanceModal.addEventListener("click", openBalanceSetup);
elements.startSetupButton.addEventListener("click", openBalanceSetup);
elements.restoreSetupButton.addEventListener("click", () => navigate("data"));
elements.openRecoveryDataButton.addEventListener("click", () => navigate("data"));
elements.balanceForm.addEventListener("submit", event => {
  event.preventDefault();
  try {
    if (!setAccountBalance(elements.accountLabelInput.value, elements.balanceAmountInput.value, elements.balanceDateInput.value)) { renderAll(); return; }
  } catch (error) {
    window.alert(error.message);
    return;
  }
  renderAll(); elements.balanceDialog.close(); showToast("確認済み残高を更新しました");
});

elements.openThresholdModal.addEventListener("click", () => {
  elements.thresholdInput.value = state.settings.alertThreshold;
  elements.thresholdDialog.showModal();
});
elements.thresholdForm.addEventListener("submit", event => {
  event.preventDefault();
  state.settings.alertThreshold = Number(elements.thresholdInput.value);
  if (!saveData()) { renderAll(); return; }
  renderHome(); elements.thresholdDialog.close(); showToast("警告基準額を保存しました");
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
  if (!saveData()) { renderAll(); return; }
  renderAll(); elements.transactionDialog.close(); showToast(previous ? "入出金を更新しました" : "入出金を追加しました");
});

elements.transactionList.addEventListener("click", event => {
  const target = event.target.closest("[data-action]");
  if (!target) return;
  const action = target.dataset.action;
  const recurringId = target.dataset.recurringId;
  const occurrenceMonth = target.dataset.occurrenceMonth;
  if (action === "virtual-edit") { openOccurrenceDialog(recurringId, occurrenceMonth); return; }
  if (action === "virtual-actual") { openOccurrenceDialog(recurringId, occurrenceMonth, { actual: true }); return; }
  if (action === "virtual-skip") {
    if (!window.confirm("この発生分だけをスキップしますか？\n固定設定と他の月は変更しません。")) return;
    upsertRecurringAdjustment(state, { recurringId, occurrenceMonth, action: "skip" });
    if (!saveData()) { renderAll(); return; }
    renderAll(); showToast("今回の予定をスキップしました");
    return;
  }
  if (action === "adjustment-clear") {
    if (!window.confirm("今回だけの変更を取り消し、固定設定の予定へ戻しますか？")) return;
    removeRecurringAdjustment(state, recurringId, occurrenceMonth);
    if (!saveData()) { renderAll(); return; }
    renderAll(); showToast("固定設定の予定へ戻しました");
    return;
  }
  if (action === "link-recurring") {
    if (!window.confirm("この保存済み取引を固定予定に紐付けますか？\n取引の日付・金額・内容は変更しません。")) return;
    try {
      linkTransactionToOccurrence(state, target.dataset.id, recurringId, occurrenceMonth);
      if (!saveData()) { renderAll(); return; }
      renderAll(); showToast("固定予定に紐付けました");
    } catch (error) {
      window.alert(`紐付けできません。\n${error.message}`);
      renderAll();
    }
    return;
  }
  const item = state.transactions.find(transaction => transaction.id === target.dataset.id);
  if (!item) return;
  if (action === "edit") openTransaction(item);
  if (action === "actual") openTransaction(item, true);
  const deleteMessage = item.recurringId && item.generatedMonth
    ? `「${item.title}」の保存済み取引を削除しますか？\n固定設定は残るため、この発生分は仮想予定として再表示されます。個別に除外する場合はスキップ操作が必要です。`
    : `「${item.title}」を削除しますか？`;
  if (action === "delete" && confirmDelete(deleteMessage)) {
    state.transactions = state.transactions.filter(transaction => transaction.id !== item.id);
    if (!saveData()) { renderAll(); return; }
    renderAll(); showToast(item.recurringId && item.generatedMonth ? "保存済み取引を削除し、仮想予定へ戻しました" : "入出金を削除しました");
  }
});

elements.occurrenceDate.addEventListener("change", updateOccurrenceForecastNote);
elements.occurrenceForm.addEventListener("submit", event => {
  event.preventDefault();
  if (elements.occurrenceDialog.dataset.mode === "actual") {
    elements.occurrenceActualButton.click();
    return;
  }
  const recurringId = elements.occurrenceRecurringId.value;
  const occurrenceMonth = elements.occurrenceMonth.value;
  try {
    getEditableOccurrence(recurringId, occurrenceMonth);
    upsertRecurringAdjustment(state, {
      recurringId,
      occurrenceMonth,
      action: "override",
      date: elements.occurrenceDate.value,
      amount: Number(elements.occurrenceAmount.value),
      memo: elements.occurrenceMemo.value.trim()
    });
    if (!saveData()) { renderAll(); return; }
    renderAll(); elements.occurrenceDialog.close(); showToast("今回だけの変更を保存しました");
  } catch (error) {
    window.alert(`変更を保存できません。\n${error.message}`);
  }
});
elements.occurrenceActualButton.addEventListener("click", () => {
  if (!window.confirm("この内容を実績として保存しますか？")) return;
  const recurringId = elements.occurrenceRecurringId.value;
  const occurrenceMonth = elements.occurrenceMonth.value;
  try {
    const occurrence = getEditableOccurrence(recurringId, occurrenceMonth);
    registerActualOccurrence(state, occurrence, {
      date: elements.occurrenceDate.value,
      amount: Number(elements.occurrenceAmount.value),
      memo: elements.occurrenceMemo.value.trim()
    });
    if (!saveData()) { renderAll(); return; }
    renderAll(); elements.occurrenceDialog.close(); showToast("実績として登録しました");
  } catch (error) {
    window.alert(`実績登録できません。\n${error.message}`);
    renderAll();
  }
});
elements.occurrenceResetButton.addEventListener("click", () => {
  if (!window.confirm("今回だけの変更を取り消しますか？")) return;
  removeRecurringAdjustment(state, elements.occurrenceRecurringId.value, elements.occurrenceMonth.value);
  if (!saveData()) { renderAll(); return; }
  renderAll(); elements.occurrenceDialog.close(); showToast("今回だけの変更を取り消しました");
});
elements.occurrenceSkipButton.addEventListener("click", () => {
  if (!window.confirm("この発生分だけをスキップしますか？\n固定設定と他の月は変更しません。")) return;
  upsertRecurringAdjustment(state, {
    recurringId: elements.occurrenceRecurringId.value,
    occurrenceMonth: elements.occurrenceMonth.value,
    action: "skip"
  });
  if (!saveData()) { renderAll(); return; }
  renderAll(); elements.occurrenceDialog.close(); showToast("今回の予定をスキップしました");
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
  const effectiveMonth = currentJapanMonth();
  if (previous) {
    upsertRecurringRuleVersion(state, recurring.id, effectiveMonth, recurring);
  } else {
    state.recurringItems.push({ ...recurring, enabled: false });
    upsertRecurringRuleVersion(state, recurring.id, effectiveMonth, recurring);
  }
  if (!saveData()) { renderAll(); return; }
  renderAll(); elements.recurringDialog.close(); showToast(previous ? "今月以降の固定設定を更新しました" : "固定設定を追加しました");
});

elements.recurringList.addEventListener("click", event => {
  const button = event.target.closest("[data-rec-action]");
  if (!button) return;
  const item = state.recurringItems.find(recurring => recurring.id === button.dataset.id);
  if (!item) return;
  const effectiveItem = resolveRecurringRule(state, item.id, currentJapanMonth());
  if (button.dataset.recAction === "edit") openRecurring(effectiveItem);
  if (button.dataset.recAction === "toggle") {
    const updated = { ...effectiveItem, enabled: !effectiveItem.enabled };
    upsertRecurringRuleVersion(state, item.id, currentJapanMonth(), updated);
    if (!saveData()) { renderAll(); return; }
    renderAll(); showToast(updated.enabled ? "今月以降を有効にしました" : "今月以降を無効にしました");
  }
  if (button.dataset.recAction === "delete" && confirmDelete(`「${effectiveItem.title}」を今月以降、無効にしますか？\n過去の設定と作成済みの入出金は残ります。`)) {
    upsertRecurringRuleVersion(state, item.id, currentJapanMonth(), { ...effectiveItem, enabled: false });
    if (!saveData()) { renderAll(); return; }
    renderAll(); showToast("今月以降の固定設定を無効にしました");
  }
});
function downloadJson(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function recoveryBackupData() {
  return {
    backupFormat: "careAccountManagerRecoveryV1",
    exportedAt: new Date().toISOString(),
    storageKey: STORAGE_KEY,
    rawData: rawStoredData,
    validationError: storageProtectionError
  };
}

elements.exportButton.addEventListener("click", () => {
  try {
    if (storageProtectionError) {
      downloadJson(recoveryBackupData(), `介護用口座_復旧用_${dateKey(new Date())}.json`);
    } else {
      downloadJson(state, `介護用口座_${dateKey(new Date())}.json`);
    }
    showToast("ダウンロードを開始しました。保存先を確認してください");
  } catch (error) {
    window.alert(`ダウンロードを開始できませんでした。\n${error.message}`);
  }
});

function importAccountJson(jsonText, backupConfirmed) {
  // Validate before any persistent write, including recovery envelopes from this app.
  let raw = JSON.parse(jsonText);
  if (isPlainObject(raw) && raw.backupFormat === "careAccountManagerRecoveryV1") {
    if (raw.storageKey !== STORAGE_KEY || typeof raw.rawData !== "string") throw new Error("復旧用JSONの元データがありません。");
    raw = JSON.parse(raw.rawData);
  }
  const candidate = normalizeData(raw);
  if ((rawStoredData !== null || storageProtectionError) && !backupConfirmed) {
    throw new Error("先に現在のデータをJSONで取得・保管し、ファイルの保存確認にチェックしてください。");
  }
  const serialized = JSON.stringify(candidate);
  localStorage.setItem(STORAGE_KEY, serialized);
  state = candidate;
  lastPersistedState = cloneData(candidate);
  rawStoredData = serialized;
  storageProtectionError = "";
  migrationNotice = "";
  lastSaveError = "";
  elements.importBackupConfirmed.checked = false;
}

elements.importInput.addEventListener("change", async event => {
  const file = event.target.files[0];
  if (!file) return;
  if ((rawStoredData !== null || storageProtectionError) && !elements.importBackupConfirmed.checked) {
    window.alert("先に現在のデータをJSONで取得・保管してください。ダウンロード一覧やファイルアプリで保存を確認し、チェックを付けてからインポートしてください。");
    event.target.value = ""; return;
  }
  if (!window.confirm("インポートすると、現在のデータはすべて置き換わります。自動バックアップは行いません。\n続けますか？")) {
    event.target.value = ""; return;
  }
  try {
    importAccountJson(await file.text(), elements.importBackupConfirmed.checked);
    renderAll(); showToast("データを復元しました");
  } catch (error) {
    window.alert(`読み込みに失敗しました。\n既存データは変更していません。\n${error.message}`);
  }
  event.target.value = "";
});

function resetAccountData() {
  state = getInitialData();
  return saveData();
}

elements.resetButton.addEventListener("click", () => {
  if (storageProtectionError) { window.alert("保存データの保護中は初期化できません。データ管理から復旧してください。"); return; }
  if (!window.confirm("残高、取引、固定設定、変更履歴をすべて消去して未設定状態に戻します。\n必要なJSONを保存・保管しましたか？この操作は取り消せません。続けますか？")) return;
  if (!resetAccountData()) { renderAll(); return; }
  renderAll(); showToast("データを消去し、未設定状態に戻しました");
});

document.querySelectorAll("dialog").forEach(dialog => dialog.addEventListener("click", event => {
  if (event.target === dialog) dialog.close();
}));
document.querySelectorAll("[data-close-dialog]").forEach(button => button.addEventListener("click", () => {
  button.closest("dialog").close();
}));

renderAll();
