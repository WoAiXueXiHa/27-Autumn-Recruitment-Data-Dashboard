const JOB_STATUSES = ["待投递", "已投递", "笔试", "一面", "二面/多面", "HR面", "Offer", "拒绝", "暂停"];
const STATUS_GROUPS = ["待投递", "已投递", "笔试", "面试", "Offer"];
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const SEARCH_CONTEXTS = {
  applications: { inputId: "jobSearch", placeholder: "搜索公司、岗位、城市", render: renderApplications },
  reviews: { inputId: "reviewSearch", placeholder: "搜索公司、岗位或面试题", render: renderReviews },
  hot100: { inputId: "problemSearch", placeholder: "搜索题号或题名", render: renderProblems },
};

let state = null;
let currentView = "overview";
let jobView = "table";
let saveTimer = null;
let savePromise = Promise.resolve(true);
let toastTimer = null;

document.addEventListener("DOMContentLoaded", boot);

async function boot() {
  bindStaticEvents();
  populateStaticOptions();
  try {
    const response = await fetch("/api/state", { cache: "no-store" });
    if (!response.ok) throw new Error("读取失败");
    state = await response.json();
    applyTheme(state.settings?.theme || "auto");
    renderAll();
  } catch (error) {
    showToast("无法连接本地服务，请重新双击“启动看板”");
    document.body.classList.add("offline");
  }
}

function bindStaticEvents() {
  $$(".nav-item").forEach(button => button.addEventListener("click", () => switchView(button.dataset.view)));
  $$('[data-view-link]').forEach(button => button.addEventListener("click", () => switchView(button.dataset.viewLink)));
  $$('[data-action="add-application"]').forEach(button => button.addEventListener("click", () => openApplicationDialog()));
  $$('[data-action="add-review"]').forEach(button => button.addEventListener("click", () => openReviewDialog()));
  $$('[data-close]').forEach(button => button.addEventListener("click", closeDialogs));
  $("#modalBackdrop").addEventListener("click", closeDialogs);
  $("#menuToggle").addEventListener("click", () => $(".sidebar").classList.toggle("open"));
  $("#themeToggle").addEventListener("click", cycleTheme);
  $("#globalSearch").addEventListener("input", handleContextSearch);
  $("#topPrimaryAction").addEventListener("click", handleTopPrimaryAction);
  $("#notificationButton").addEventListener("click", () => { switchView("overview"); $("#upcomingList").scrollIntoView({ behavior: "smooth" }); });

  $("#jobSearch").addEventListener("input", () => handleModuleSearch("applications"));
  ["jobStatusFilter", "jobPriorityFilter", "jobSort"].forEach(id => $("#" + id).addEventListener("input", renderApplications));
  $$("[data-job-view]").forEach(button => button.addEventListener("click", () => {
    jobView = button.dataset.jobView;
    $$("[data-job-view]").forEach(item => item.classList.toggle("active", item === button));
    renderApplications();
  }));
  $("#problemSearch").addEventListener("input", () => handleModuleSearch("hot100"));
  ["problemCategory", "problemDifficulty", "problemStatus", "problemMastery", "problemSort"].forEach(id => $("#" + id).addEventListener("input", renderProblems));
  $("#reviewSearch").addEventListener("input", () => handleModuleSearch("reviews"));
  ["reviewRoundFilter", "reviewResultFilter", "reviewSort"].forEach(id => $("#" + id).addEventListener("input", renderReviews));

  $("#applicationForm").addEventListener("submit", saveApplicationForm);
  $("#problemForm").addEventListener("submit", saveProblemForm);
  $("#reviewForm").addEventListener("submit", saveReviewForm);
  $("#deleteApplication").addEventListener("click", deleteCurrentApplication);
  $("#deleteReview").addEventListener("click", deleteCurrentReview);
  $("#importButton").addEventListener("click", () => $("#importFile").click());
  $("#importFile").addEventListener("change", importFile);
  $("#exportHot100").addEventListener("click", exportHot100Markdown);
  $("#reminderToggle").addEventListener("change", event => { state.settings.reminders = event.target.checked; scheduleSave(); });
  $("#leadHours").addEventListener("change", event => { state.settings.reminderLeadHours = Math.max(1, Math.min(168, Number(event.target.value) || 24)); scheduleSave(); });
  $("#testNotification").addEventListener("click", testNotification);
  $$('[data-markdown-mode]').forEach(button => button.addEventListener("click", () => setMarkdownMode(button.dataset.markdownMode)));
  $$(".markdown-toolbar [data-md-action]").forEach(button => button.addEventListener("click", () => applyMarkdownFormat(button.closest(".markdown-field").querySelector("textarea"), button.dataset.mdAction)));
  $$("[data-mastery]").forEach(button => button.addEventListener("click", () => setMastery(button.dataset.mastery)));
  $$("#problemForm textarea").forEach(textarea => textarea.addEventListener("input", updateMarkdownPreviews));
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { if (state?.settings?.theme === "auto") applyTheme("auto"); });
}

function populateStaticOptions() {
  JOB_STATUSES.forEach(status => {
    $("#jobStatusFilter").insertAdjacentHTML("beforeend", `<option>${escapeHtml(status)}</option>`);
    $("#applicationForm [name=status]").insertAdjacentHTML("beforeend", `<option>${escapeHtml(status)}</option>`);
  });
}

function renderAll() {
  if (!state) return;
  state.interviewReviews ||= [];
  const categories = [...new Set(state.problems.map(item => item.category))];
  const categorySelect = $("#problemCategory");
  if (categorySelect.options.length === 1) categories.forEach(category => categorySelect.insertAdjacentHTML("beforeend", `<option>${escapeHtml(category)}</option>`));
  $("#reminderToggle").checked = state.settings?.reminders !== false;
  $("#leadHours").value = state.settings?.reminderLeadHours || 24;
  $("#lastSaved").textContent = state.updatedAt ? `上次保存：${formatDateTime(state.updatedAt)}` : "尚未保存";
  const noteCount = state.problems.filter(problem => String(problem.thoughts || "").trim()).length;
  $("#exportHot100").textContent = `Hot 100 思路（${noteCount}）`;
  renderOverview();
  renderApplications();
  renderReviews();
  renderProblems();
  syncTopbarForView();
}

function switchView(view) {
  currentView = view;
  $$(".view").forEach(item => item.classList.toggle("active", item.id === `view-${view}`));
  $$(".nav-item").forEach(item => item.classList.toggle("active", item.dataset.view === view));
  const titles = { overview: "今天也向前一步。", applications: "让每次投递都有迹可循。", reviews: "把每次面试，变成下一次的底气。", hot100: "把不会的题，变成你的题。", data: "数据只属于你。" };
  $("#pageTitle").textContent = titles[view];
  $("#eyebrow").textContent = dateEyebrow();
  syncTopbarForView();
  $(".sidebar").classList.remove("open");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderOverview() {
  const jobs = state.applications;
  const solved = state.problems.filter(item => item.status === "已完成" || item.status === "待复习").length;
  const interviewing = jobs.filter(item => ["一面", "二面/多面", "HR面"].includes(item.status)).length;
  const offers = jobs.filter(item => item.status === "Offer").length;
  const reviewDue = state.problems.filter(item => item.nextReviewAt && new Date(item.nextReviewAt) <= endOfToday()).length;
  const stats = [
    ["累计投递", jobs.length, jobs.length ? `${jobs.filter(j => isThisWeek(j.applyDate)).length} 份在本周新增` : "从第一份目标岗位开始"],
    ["面试进行中", interviewing, interviewing ? "保持节奏，逐场复盘" : "等待下一次机会到来"],
    ["已收获 Offer", offers, offers ? "太棒了，继续比较选择" : "目标明确，稳步推进"],
    ["Hot 100", `${solved}%`, `${solved} / 100 已完成`],
  ];
  $("#overviewStats").innerHTML = stats.map(([label, value, foot]) => `<article class="stat-card"><div class="stat-label">${label}</div><div class="stat-value">${value}</div><div class="stat-foot">${foot}</div></article>`).join("");

  const events = upcomingEvents();
  $("#notificationCount").textContent = events.length + reviewDue;
  $("#notificationCount").style.display = events.length + reviewDue ? "grid" : "none";
  $("#upcomingList").innerHTML = events.length ? events.slice(0, 5).map(event => {
    const date = new Date(event.time);
    return `<div class="upcoming-item"><div class="date-tile"><strong>${String(date.getDate()).padStart(2, "0")}</strong><span>${monthName(date)}</span></div><div class="item-main"><strong>${escapeHtml(event.company)}</strong><span>${escapeHtml(event.position)} · ${formatTime(event.time)}</span></div><span class="event-chip ${event.type === "笔试" ? "exam" : ""}">${event.type}</span></div>`;
  }).join("") : emptyMini("◇", "还没有近期笔试或面试", "新增投递时填写时间即可提醒");

  const groups = ["简单", "中等", "困难"].map(level => {
    const list = state.problems.filter(item => item.difficulty === level);
    return { level, done: list.filter(item => ["已完成", "待复习"].includes(item.status)).length, total: list.length };
  });
  $("#hotProgress").innerHTML = `<div class="progress-ring" style="--progress:${solved * 3.6}deg"><div><strong>${solved}</strong><span>OF 100</span></div></div><div class="difficulty-bars">${groups.map((g, index) => `<div><div class="bar-label"><span>${g.level}</span><b>${g.done} / ${g.total}</b></div><div class="bar-track"><div class="bar-fill ${index === 1 ? "medium" : index === 2 ? "hard" : ""}" style="width:${g.total ? g.done / g.total * 100 : 0}%"></div></div></div>`).join("")}</div>`;

  const funnel = [
    ["已投递", jobs.filter(j => j.status !== "待投递").length],
    ["笔试", jobs.filter(j => ["笔试", "一面", "二面/多面", "HR面", "Offer"].includes(j.status)).length],
    ["面试", jobs.filter(j => ["一面", "二面/多面", "HR面", "Offer"].includes(j.status)).length],
    ["HR 面", jobs.filter(j => ["HR面", "Offer"].includes(j.status)).length],
    ["Offer", offers],
  ];
  const maximum = Math.max(1, ...funnel.map(item => item[1]));
  $("#funnelChart").innerHTML = funnel.map(([label, count]) => `<div class="funnel-row"><span>${label}</span><div class="funnel-bar"><i style="width:${count / maximum * 100}%"></i></div><strong>${count}</strong></div>`).join("");

  const reviews = reviewProblems();
  $("#reviewBadge").textContent = reviews.length;
  $("#reviewList").innerHTML = reviews.length ? reviews.slice(0, 5).map(problem => `<div class="review-item" data-problem="${problem.id}"><div class="review-number">#${problem.number}</div><div class="item-main"><strong>${escapeHtml(problem.title)}</strong><span>${escapeHtml(problem.category)} · 已复习 ${problem.reviewCount || 0} 次</span></div><span class="${isOverdue(problem.nextReviewAt) ? "overdue" : ""}" style="font-size:10px">${relativeDate(problem.nextReviewAt)}</span></div>`).join("") : emptyMini("✓", "复习队列已清空", "完成题目后设置下次复习时间");
  $$('[data-problem]', $("#reviewList")).forEach(item => item.addEventListener("click", () => openProblemDialog(item.dataset.problem)));
}

function getFilteredJobs() {
  const query = $("#jobSearch").value.trim().toLowerCase();
  const status = $("#jobStatusFilter").value;
  const priority = $("#jobPriorityFilter").value;
  const sort = $("#jobSort").value;
  let jobs = state.applications.filter(item => {
    const haystack = [item.company, item.position, item.city, item.channel, item.notes].join(" ").toLowerCase();
    return (!query || haystack.includes(query)) && (!status || item.status === status) && (!priority || item.priority === priority);
  });
  const priorityScore = { 高: 3, 中: 2, 低: 1 };
  jobs.sort((a, b) => {
    if (sort === "company") return (a.company || "").localeCompare(b.company || "", "zh-CN");
    if (sort === "applyDate-desc") return (b.applyDate || "").localeCompare(a.applyDate || "");
    if (sort === "priority") return (priorityScore[b.priority] || 0) - (priorityScore[a.priority] || 0);
    return (b.updatedAt || b.applyDate || "").localeCompare(a.updatedAt || a.applyDate || "");
  });
  return jobs;
}

function renderApplications() {
  if (!state) return;
  const jobs = getFilteredJobs();
  $("#jobTableWrap").hidden = jobView !== "table";
  $("#jobKanban").hidden = jobView !== "kanban";
  $("#jobTable").innerHTML = jobs.length ? jobs.map(job => {
    const next = nextJobEvent(job);
    return `<tr data-job="${job.id}"><td class="primary-cell"><strong>${escapeHtml(job.company || "未命名公司")}</strong><span>${escapeHtml(job.position || "未填写岗位")} · ${escapeHtml(job.channel || "未填写渠道")}</span></td><td>${escapeHtml(job.city || "—")}</td><td>${formatDate(job.applyDate)}</td><td><span class="status-chip ${statusClass(job.status)}">${escapeHtml(job.status || "待投递")}</span></td><td><span class="priority-chip ${priorityClass(job.priority)}">${escapeHtml(job.priority || "中")}</span></td><td>${next ? `<span class="${isOverdue(next.time) ? "overdue" : ""}">${next.type} · ${formatShort(next.time)}</span>` : "—"}</td><td><button class="row-action" aria-label="编辑">···</button></td></tr>`;
  }).join("") : `<tr><td colspan="7">${emptyMini("◎", "还没有投递记录", "点击“新增投递”，建立第一张卡片")}</td></tr>`;
  $$('[data-job]', $("#jobTable")).forEach(row => row.addEventListener("click", () => openApplicationDialog(row.dataset.job)));

  $("#jobKanban").innerHTML = JOB_STATUSES.slice(0, 8).map(status => {
    const cards = jobs.filter(job => job.status === status);
    return `<div class="kanban-column" data-status="${status}"><div class="kanban-head">${status}<span>${cards.length}</span></div><div class="kanban-cards">${cards.map(job => `<article class="job-card" draggable="true" data-job="${job.id}"><strong>${escapeHtml(job.company)}</strong><p>${escapeHtml(job.position)}</p><div class="job-card-foot"><span>${escapeHtml(job.city || "未定")}</span><span class="priority-chip ${priorityClass(job.priority)}">${job.priority || "中"}</span></div></article>`).join("")}</div></div>`;
  }).join("");
  bindKanban();
}

function bindKanban() {
  $$(".job-card", $("#jobKanban")).forEach(card => {
    card.addEventListener("click", () => openApplicationDialog(card.dataset.job));
    card.addEventListener("dragstart", event => { event.dataTransfer.setData("text/plain", card.dataset.job); card.style.opacity = ".5"; });
    card.addEventListener("dragend", () => { card.style.opacity = ""; });
  });
  $$(".kanban-column", $("#jobKanban")).forEach(column => {
    column.addEventListener("dragover", event => event.preventDefault());
    column.addEventListener("drop", event => {
      event.preventDefault();
      const job = state.applications.find(item => item.id === event.dataTransfer.getData("text/plain"));
      if (!job) return;
      job.status = column.dataset.status;
      job.updatedAt = new Date().toISOString();
      scheduleSave(); renderApplications(); renderOverview();
    });
  });
}

function getFilteredProblems() {
  const rawQuery = $("#problemSearch").value.trim().toLowerCase();
  const query = rawQuery.replace(/^#/, "");
  const exactNumber = /^#?\d+$/.test(rawQuery) ? query : "";
  const category = $("#problemCategory").value;
  const difficulty = $("#problemDifficulty").value;
  const status = $("#problemStatus").value;
  const mastery = $("#problemMastery").value;
  const sort = $("#problemSort").value;
  const order = { 简单: 1, 中等: 2, 困难: 3 };
  let problems = state.problems.filter(item => {
    const masteryMatches = !mastery || (mastery === "unset" ? ![1, 2, 3].includes(Number(item.mastery)) : Number(item.mastery) === Number(mastery));
    const queryMatches = !query || (exactNumber ? String(item.number) === exactNumber : item.title.toLowerCase().includes(query));
    return queryMatches && (!category || item.category === category) && (!difficulty || item.difficulty === difficulty) && (!status || item.status === status) && masteryMatches;
  });
  if (sort === "number") problems.sort((a, b) => a.number - b.number);
  if (sort === "difficulty") problems.sort((a, b) => order[a.difficulty] - order[b.difficulty]);
  if (sort === "review") problems.sort((a, b) => (a.nextReviewAt || "9999").localeCompare(b.nextReviewAt || "9999"));
  return problems;
}

function renderProblems() {
  if (!state) return;
  const problems = getFilteredProblems();
  const done = state.problems.filter(item => ["已完成", "待复习"].includes(item.status)).length;
  $("#hotSummary").innerHTML = `<div class="small-ring"></div><div><strong>${done}%</strong><span>${done} / 100 已完成</span></div>`;
  const categoryCounts = [...new Set(state.problems.map(item => item.category))].map(category => [category, state.problems.filter(item => item.category === category).length]);
  $("#categoryStrip").innerHTML = `<button class="category-pill ${$("#problemCategory").value ? "" : "active"}" data-category="">全部 <b>100</b></button>${categoryCounts.map(([category, count]) => `<button class="category-pill ${$("#problemCategory").value === category ? "active" : ""}" data-category="${category}">${category} <b>${count}</b></button>`).join("")}`;
  $$("[data-category]", $("#categoryStrip")).forEach(button => button.addEventListener("click", () => { $("#problemCategory").value = button.dataset.category; renderProblems(); }));
  $("#problemTable").innerHTML = problems.map(problem => `<tr data-problem="${problem.id}"><td><button class="problem-check ${problemStatusClass(problem.status)}" data-toggle-problem="${problem.id}" title="切换完成状态">${problemStatusIcon(problem.status)}</button></td><td><div class="problem-title"><b>#${problem.number}</b><a class="problem-link" href="https://leetcode.cn/problems/${problem.slug}/" target="_blank" rel="noreferrer" title="在力扣打开 ${escapeHtml(problem.title)}"><strong>${escapeHtml(problem.title)}</strong><span>↗</span></a>${(problem.thoughts || problem.mistakes) ? '<i class="problem-notes-dot" title="已有笔记"></i>' : ""}</div></td><td><span class="difficulty-chip ${difficultyClass(problem.difficulty)}">${problem.difficulty}</span></td><td><span class="category-label">${escapeHtml(problem.category)}</span></td><td>${masteryDisplay(problem.mastery)}</td><td>${problem.firstSolvedAt ? formatDate(problem.firstSolvedAt) : "—"}</td><td><span class="review-count"><b>${problem.reviewCount || 0}</b> 次${problem.nextReviewAt ? ` · ${relativeDate(problem.nextReviewAt)}` : ""}</span></td><td><button class="row-action" aria-label="编辑记录">···</button></td></tr>`).join("");
  $("#problemEmpty").hidden = problems.length !== 0;
  $("#problemTable").closest(".table-wrap").hidden = problems.length === 0;
  $$('[data-problem]', $("#problemTable")).forEach(row => row.addEventListener("click", event => { if (!event.target.closest("[data-toggle-problem], a")) openProblemDialog(row.dataset.problem); }));
  $$('[data-toggle-problem]', $("#problemTable")).forEach(button => button.addEventListener("click", event => { event.stopPropagation(); quickToggleProblem(button.dataset.toggleProblem); }));
}

function getFilteredReviews() {
  const query = $("#reviewSearch").value.trim().toLowerCase();
  const round = $("#reviewRoundFilter").value;
  const result = $("#reviewResultFilter").value;
  const sort = $("#reviewSort").value;
  const reviews = (state.interviewReviews || []).filter(item => {
    const haystack = [item.company, item.position, item.questions, item.strengths, item.gaps, item.actions].join(" ").toLowerCase();
    return (!query || haystack.includes(query)) && (!round || item.round === round) && (!result || item.result === result);
  });
  reviews.sort((a, b) => {
    if (sort === "company") return (a.company || "").localeCompare(b.company || "", "zh-CN");
    if (sort === "rating-desc") return Number(b.rating || 0) - Number(a.rating || 0);
    return (b.interviewDate || b.updatedAt || "").localeCompare(a.interviewDate || a.updatedAt || "");
  });
  return reviews;
}

function renderReviews() {
  if (!state) return;
  state.interviewReviews ||= [];
  const all = state.interviewReviews;
  const reviews = getFilteredReviews();
  const rated = all.filter(item => Number(item.rating));
  const decided = all.filter(item => ["通过", "未通过"].includes(item.result));
  const passed = decided.filter(item => item.result === "通过").length;
  const stats = [
    ["累计复盘", all.length, "场面试已沉淀"],
    ["平均自评", rated.length ? (rated.reduce((sum, item) => sum + Number(item.rating), 0) / rated.length).toFixed(1) : "—", "满分 5 分"],
    ["面试通过率", decided.length ? `${Math.round(passed / decided.length * 100)}%` : "—", `${passed} / ${decided.length || 0} 场已通过`],
    ["待确认结果", all.filter(item => item.result === "待定").length, "记得及时更新结果"],
  ];
  $("#reviewStats").innerHTML = stats.map(([label, value, foot]) => `<article class="stat-card"><div class="stat-label">${label}</div><div class="stat-value">${value}</div><div class="stat-foot">${foot}</div></article>`).join("");
  $("#reviewCards").innerHTML = reviews.map(review => {
    const questionCount = String(review.questions || "").split(/\n+/).filter(Boolean).length;
    return `<article class="retrospective-card" data-review="${review.id}">
      <div class="retro-head"><div><span class="result-chip ${reviewResultClass(review.result)}">${escapeHtml(review.result || "待定")}</span><span class="round-chip">${escapeHtml(review.round || "一面")}</span></div><time>${formatShort(review.interviewDate)}</time></div>
      <h3>${escapeHtml(review.company || "未命名公司")}</h3><p class="retro-position">${escapeHtml(review.position || "未填写岗位")} · ${escapeHtml(review.format || "形式未记录")}</p>
      <div class="rating-row"><span>自评</span><strong>${ratingStars(review.rating)}</strong><b>${Number(review.rating || 0) || "—"}/5</b></div>
      <div class="retro-preview"><span>面试题 ${questionCount ? `· ${questionCount} 项` : ""}</span><p>${escapeHtml(review.questions || "尚未记录面试题与追问")}</p></div>
      <div class="retro-action"><span>下一步</span><p>${escapeHtml(review.actions || "尚未记录行动项")}</p></div>
      <button class="text-button">查看完整复盘 →</button>
    </article>`;
  }).join("");
  $("#reviewEmpty").hidden = reviews.length !== 0;
  $$('[data-review]', $("#reviewCards")).forEach(card => card.addEventListener("click", () => openReviewDialog(card.dataset.review)));
}

function openApplicationDialog(id = "") {
  const form = $("#applicationForm");
  form.reset();
  const job = state.applications.find(item => item.id === id);
  $("#applicationDialogTitle").textContent = job ? "编辑投递" : "新增投递";
  $("#deleteApplication").hidden = !job;
  const values = job || { id: "", status: "待投递", priority: "中", applyDate: localDateValue(new Date()) };
  Object.entries(values).forEach(([key, value]) => { if (form.elements[key]) form.elements[key].value = value ?? ""; });
  openDialog($("#applicationDialog"));
  setTimeout(() => form.elements.company.focus(), 50);
}

function saveApplicationForm(event) {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(event.currentTarget).entries());
  const existing = state.applications.find(item => item.id === values.id);
  if (existing) Object.assign(existing, values, { updatedAt: new Date().toISOString() });
  else state.applications.unshift({ ...values, id: `job-${Date.now()}`, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  closeDialogs(); scheduleSave(); renderAll(); showToast(existing ? "投递记录已更新" : "投递记录已添加");
}

function deleteCurrentApplication() {
  const id = $("#applicationForm").elements.id.value;
  const job = state.applications.find(item => item.id === id);
  if (!job || !confirm(`确定删除“${job.company} · ${job.position}”吗？`)) return;
  state.applications = state.applications.filter(item => item.id !== id);
  closeDialogs(); scheduleSave(); renderAll(); showToast("投递记录已删除");
}

function openReviewDialog(id = "") {
  const form = $("#reviewForm");
  form.reset();
  const review = (state.interviewReviews || []).find(item => item.id === id);
  $("#reviewDialogTitle").textContent = review ? "编辑面经复盘" : "新增面经复盘";
  $("#deleteReview").hidden = !review;
  const applicationSelect = form.elements.applicationId;
  applicationSelect.innerHTML = '<option value="">不关联投递</option>' + state.applications.map(job => `<option value="${job.id}">${escapeHtml(job.company)} · ${escapeHtml(job.position)}</option>`).join("");
  const values = review || { id: "", applicationId: "", interviewDate: localDateTimeValue(new Date()), round: "一面", result: "待定", rating: 3 };
  Object.entries(values).forEach(([key, value]) => { if (form.elements[key]) form.elements[key].value = value ?? ""; });
  applicationSelect.onchange = () => {
    const job = state.applications.find(item => item.id === applicationSelect.value);
    if (job) { form.elements.company.value = job.company || ""; form.elements.position.value = job.position || ""; }
  };
  openDialog($("#reviewDialog"));
  setTimeout(() => (review ? form.elements.questions : form.elements.company).focus(), 50);
}

function saveReviewForm(event) {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(event.currentTarget).entries());
  values.rating = Math.max(1, Math.min(5, Number(values.rating) || 3));
  const existing = state.interviewReviews.find(item => item.id === values.id);
  if (existing) Object.assign(existing, values, { updatedAt: new Date().toISOString() });
  else state.interviewReviews.unshift({ ...values, id: `review-${Date.now()}`, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  closeDialogs(); scheduleSave(); renderReviews(); showToast(existing ? "面经复盘已更新" : "面经复盘已保存");
}

function deleteCurrentReview() {
  const id = $("#reviewForm").elements.id.value;
  const review = state.interviewReviews.find(item => item.id === id);
  if (!review || !confirm(`确定删除“${review.company} · ${review.round}”的复盘吗？`)) return;
  state.interviewReviews = state.interviewReviews.filter(item => item.id !== id);
  closeDialogs(); scheduleSave(); renderReviews(); showToast("面经复盘已删除");
}

function openProblemDialog(id) {
  const problem = state.problems.find(item => item.id === id);
  if (!problem) return;
  const form = $("#problemForm"); form.reset();
  $("#problemDialogCategory").textContent = problem.category.toUpperCase();
  $("#problemDialogTitle").textContent = `#${problem.number} ${problem.title}`;
  $("#problemMeta").innerHTML = `<span class="difficulty-chip ${difficultyClass(problem.difficulty)}">${problem.difficulty}</span><span class="status-chip">${escapeHtml(problem.category)}</span>`;
  $("#leetcodeLink").href = `https://leetcode.cn/problems/${problem.slug}/`;
  ["id", "status", "firstSolvedAt", "thoughts", "mistakes", "reviewCount", "nextReviewAt"].forEach(key => { form.elements[key].value = problem[key] ?? ""; });
  setMastery([1, 2, 3].includes(Number(problem.mastery)) ? Number(problem.mastery) : "");
  const hasMarkdownNotes = Boolean((problem.thoughts || "").trim() || (problem.mistakes || "").trim());
  setMarkdownMode(hasMarkdownNotes ? "preview" : "edit");
  updateMarkdownPreviews();
  openDialog($("#problemDialog"));
}

function saveProblemForm(event) {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(event.currentTarget).entries());
  const problem = state.problems.find(item => item.id === values.id);
  if (!problem) return;
  const mastery = values.mastery === "" ? null : Number(values.mastery);
  if (mastery !== null && ![1, 2, 3].includes(mastery)) { showToast("掌握程度只能选择一至三星"); return; }
  Object.assign(problem, values, { mastery, reviewCount: Number(values.reviewCount || 0) });
  if (["已完成", "待复习"].includes(problem.status) && !problem.firstSolvedAt) problem.firstSolvedAt = localDateTimeValue(new Date());
  closeDialogs(); scheduleSave(); renderAll(); showToast("刷题记录已保存");
}

function setMastery(value) {
  const form = $("#problemForm");
  const numeric = [1, 2, 3].includes(Number(value)) ? Number(value) : null;
  form.elements.mastery.value = numeric ?? "";
  $$(".mastery-picker [data-mastery]").forEach(button => {
    const buttonValue = Number(button.dataset.mastery);
    button.classList.toggle("active", Boolean(numeric && buttonValue && buttonValue <= numeric));
    if (buttonValue) button.setAttribute("aria-checked", buttonValue === numeric ? "true" : "false");
  });
}

function masteryDisplay(value) {
  const numeric = [1, 2, 3].includes(Number(value)) ? Number(value) : 0;
  if (!numeric) return '<span class="mastery-unset">未评估</span>';
  const labels = { 1: "薄弱", 2: "基本掌握", 3: "熟练" };
  return `<span class="mastery-stars" title="${labels[numeric]}">${"★".repeat(numeric)}${"☆".repeat(3 - numeric)}</span>`;
}

function setMarkdownMode(mode) {
  const preview = mode === "preview";
  if (preview) updateMarkdownPreviews();
  $$("[data-markdown-mode]").forEach(button => button.classList.toggle("active", button.dataset.markdownMode === mode));
  const hint = $("#markdownModeHint");
  if (hint) hint.textContent = preview ? "当前显示安全渲染结果；点击“编辑源码”继续修改" : "正在编辑 Markdown 源码；点击“渲染预览”查看排版效果";
  $$(".markdown-field").forEach(field => {
    field.querySelector("textarea").hidden = preview;
    field.querySelector(".markdown-toolbar").hidden = preview;
    field.querySelector(".markdown-preview").hidden = !preview;
  });
}

function updateMarkdownPreviews() {
  const form = $("#problemForm");
  ["thoughts", "mistakes"].forEach(name => {
    $(`[data-markdown-preview="${name}"]`).innerHTML = renderMarkdown(form.elements[name].value);
  });
}

function applyMarkdownFormat(textarea, action) {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const selected = textarea.value.slice(start, end);
  let replacement = selected;
  if (["h1", "h2", "h3"].includes(action)) {
    const lineStart = textarea.value.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
    const prefix = `${"#".repeat(Number(action.slice(1)))} `;
    textarea.setRangeText(prefix, lineStart, lineStart, "end");
    textarea.focus();
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }
  if (action === "bold") replacement = `**${selected || "重点内容"}**`;
  if (action === "inline-code") replacement = `\`${selected || "代码"}\``;
  if (action === "list") replacement = (selected || "列表项").split("\n").map(line => `- ${line.replace(/^[-*]\s+/, "")}`).join("\n");
  if (action === "code") {
    const language = textarea.closest(".markdown-field").querySelector("[data-code-language]")?.value || "";
    const examples = {
      go: "func solve() {\n\t// TODO\n}", python: "def solve():\n    pass", javascript: "function solve() {\n  // TODO\n}",
      typescript: "function solve(): void {\n  // TODO\n}", java: "static void solve() {\n    // TODO\n}", c: "void solve(void) {\n    // TODO\n}",
      cpp: "void solve() {\n    // TODO\n}", csharp: "static void Solve() {\n    // TODO\n}", rust: "fn solve() {\n    // TODO\n}",
      sql: "SELECT * FROM table_name;", bash: "echo \"TODO\"", json: "{\n  \"key\": \"value\"\n}", html: "<div>内容</div>", css: ".class {\n  color: inherit;\n}",
    };
    replacement = `\`\`\`${language}\n${selected || examples[language] || "代码"}\n\`\`\``;
  }
  textarea.setRangeText(replacement, start, end, "select");
  textarea.focus();
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

function renderMarkdown(source) {
  const lines = String(source || "").replace(/\r\n?/g, "\n").split("\n");
  const output = [];
  let inCode = false;
  let codeLanguage = "";
  let codeLines = [];
  let inList = false;
  const closeList = () => { if (inList) { output.push("</ul>"); inList = false; } };
  const pushCode = () => {
    const code = codeLines.join("\n");
    const language = normalizeCodeLanguage(codeLanguage);
    const label = `<span class="code-language">${escapeHtml(codeLanguageLabel(language))}</span>`;
    output.push(`<pre>${label}<code>${highlightCode(code, language)}</code></pre>`);
    codeLines = [];
  };
  lines.forEach(line => {
    const fence = line.match(/^```\s*([\w+-]*)\s*$/);
    if (fence) {
      if (inCode) { pushCode(); inCode = false; codeLanguage = ""; }
      else { closeList(); inCode = true; codeLanguage = fence[1] || ""; }
      return;
    }
    if (inCode) { codeLines.push(line); return; }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    const listItem = line.match(/^\s*[-*]\s+(.+)$/);
    if (heading) {
      closeList();
      const level = heading[1].length;
      output.push(`<h${level}>${renderMarkdownInline(heading[2])}</h${level}>`);
    } else if (listItem) {
      if (!inList) { output.push("<ul>"); inList = true; }
      output.push(`<li>${renderMarkdownInline(listItem[1])}</li>`);
    } else if (!line.trim()) {
      closeList();
    } else {
      closeList();
      output.push(`<p>${renderMarkdownInline(line)}</p>`);
    }
  });
  closeList();
  if (inCode) pushCode();
  return output.join("") || '<p class="markdown-empty">暂无内容</p>';
}

function renderMarkdownInline(value) {
  const source = String(value || "");
  const inlineCode = /`([^`\n]+)`/g;
  let output = "";
  let cursor = 0;
  for (const match of source.matchAll(inlineCode)) {
    output += renderBoldInline(source.slice(cursor, match.index));
    output += `<code class="inline-code">${escapeHtml(match[1])}</code>`;
    cursor = match.index + match[0].length;
  }
  return output + renderBoldInline(source.slice(cursor));
}

function renderBoldInline(value) {
  return escapeHtml(value).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

const CODE_LANGUAGE_ALIASES = {
  js: "javascript", jsx: "javascript", javascript: "javascript", ts: "typescript", tsx: "typescript", typescript: "typescript",
  py: "python", python: "python", go: "go", golang: "go", java: "java", c: "c", h: "c", cpp: "cpp", "c++": "cpp", cc: "cpp", hpp: "cpp",
  cs: "csharp", "c#": "csharp", csharp: "csharp", rs: "rust", rust: "rust", sql: "sql", sh: "bash", shell: "bash", bash: "bash", zsh: "bash",
  json: "json", html: "html", xml: "html", css: "css",
};

const CODE_LANGUAGE_LABELS = { javascript: "JavaScript", typescript: "TypeScript", python: "Python", go: "Go", java: "Java", c: "C", cpp: "C++", csharp: "C#", rust: "Rust", sql: "SQL", bash: "Shell", json: "JSON", html: "HTML / XML", css: "CSS", text: "Code" };

const CODE_LANGUAGE_CONFIGS = {
  go: { keywords: "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var", types: "bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr any", comments: "slash" },
  python: { keywords: "and as assert async await break case class continue def del elif else except False finally for from global if import in is lambda match None nonlocal not or pass raise return True try while with yield", types: "bool bytes complex dict float frozenset int list memoryview object range set slice str tuple type", comments: "hash" },
  javascript: { keywords: "async await break case catch class const continue debugger default delete do else export extends false finally for from function get if import in instanceof let new null of return set static super switch this throw true try typeof undefined var void while with yield", types: "Array BigInt Boolean Date Error Map Math Number Object Promise RegExp Set String Symbol WeakMap WeakSet", comments: "slash" },
  typescript: { keywords: "abstract any as asserts async await break case catch class const constructor continue declare default delete do else enum export extends false finally for from function get if implements import in infer instanceof interface is keyof let module namespace never new null of override private protected public readonly return satisfies set static super switch this throw true try type typeof undefined unique unknown var void while with yield", types: "Array bigint boolean Date Map number object Promise Record Set string symbol tuple", comments: "slash" },
  java: { keywords: "abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new null package private protected public return short static strictfp super switch synchronized this throw throws transient true try void volatile while false", types: "Boolean Byte Character Double Float Integer Long Object Short String StringBuilder", comments: "slash" },
  c: { keywords: "auto break case const continue default do else enum extern for goto if inline register restrict return signed sizeof static struct switch typedef union unsigned void volatile while", types: "bool char double float int int8_t int16_t int32_t int64_t long short size_t uint8_t uint16_t uint32_t uint64_t", comments: "slash" },
  cpp: { keywords: "alignas alignof and asm auto break case catch class concept const constexpr continue co_await co_return co_yield decltype default delete do else enum explicit export extern false for friend goto if inline mutable namespace new noexcept not nullptr operator or private protected public requires return sizeof static struct switch template this throw true try typedef typeid typename union using virtual void volatile while xor", types: "bool char double float int long short size_t string vector map set unordered_map unordered_set unique_ptr shared_ptr", comments: "slash" },
  csharp: { keywords: "abstract as async await base break case catch checked class const continue decimal default delegate do else enum event explicit extern false finally fixed for foreach goto if implicit in interface internal is lock namespace new null object operator out override params private protected public readonly ref return sealed sizeof stackalloc static string struct switch this throw true try typeof unchecked unsafe using virtual void volatile while", types: "bool byte char DateTime decimal double float int long object sbyte short string uint ulong ushort var", comments: "slash" },
  rust: { keywords: "as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while", types: "bool char f32 f64 i8 i16 i32 i64 i128 isize str String u8 u16 u32 u64 u128 usize Vec Option Result", comments: "slash" },
  sql: { keywords: "add all alter and any as asc backup between by case check column constraint create database default delete desc distinct drop exec exists foreign from full group having in index inner insert into is join key left like limit not null or order outer primary procedure right rownum select set table top truncate union unique update values view where with", types: "bigint binary bit blob boolean char date datetime decimal double float int integer json numeric real text time timestamp varchar", comments: "sql", insensitive: true },
  bash: { keywords: "alias bg bind break builtin case cd command continue declare dirs disown do done echo elif else enable esac eval exec exit export false fc fg fi for function getopts hash help history if in jobs kill let local logout mapfile popd printf pushd pwd read readonly return select set shift shopt source suspend test then times trap true type typeset ulimit umask unalias unset until wait while", types: "PATH HOME PWD SHELL USER", comments: "hash" },
  css: { keywords: "absolute auto block border-box both bottom center fixed flex grid hidden inherit initial inline left none relative revert right solid sticky top transparent unset", types: "important", comments: "slash" },
};

function normalizeCodeLanguage(language) {
  return CODE_LANGUAGE_ALIASES[String(language || "").trim().toLowerCase()] || "text";
}

function codeLanguageLabel(language) { return CODE_LANGUAGE_LABELS[language] || "Code"; }

function highlightCode(code, language) {
  if (language === "html") return highlightMarkup(code);
  if (language === "json") return highlightJson(code);
  const config = CODE_LANGUAGE_CONFIGS[language];
  if (!config) return escapeHtml(code);
  return highlightConfiguredCode(code, config);
}

function highlightConfiguredCode(code, config) {
  const keywords = new Set(config.keywords.split(" ").map(value => config.insensitive ? value.toLowerCase() : value));
  const types = new Set(config.types.split(" ").map(value => config.insensitive ? value.toLowerCase() : value));
  const commentPart = config.comments === "hash" ? "#[^\\n]*" : config.comments === "sql" ? "--[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/" : "\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/";
  const pattern = new RegExp(`(${commentPart}|"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|\\\`(?:\\\\.|[^\\\`\\\\])*\\\`|\\b[A-Za-z_$][\\w$]*\\b|\\b(?:0[xX][0-9a-fA-F]+|0[bB][01]+|\\d+(?:\\.\\d+)?)\\b)`, "g");
  let output = "";
  let cursor = 0;
  for (const match of code.matchAll(pattern)) {
    output += escapeHtml(code.slice(cursor, match.index));
    const token = match[0];
    const lookup = config.insensitive ? token.toLowerCase() : token;
    let kind = "";
    if (token.startsWith("//") || token.startsWith("/*") || token.startsWith("#") || token.startsWith("--")) kind = "comment";
    else if (/^["'`]/.test(token)) kind = "string";
    else if (keywords.has(lookup)) kind = "keyword";
    else if (types.has(lookup)) kind = "type";
    else if (/^(?:0[xX]|\d)/.test(token)) kind = "number";
    output += kind ? `<span class="tok-${kind}">${escapeHtml(token)}</span>` : escapeHtml(token);
    cursor = match.index + token.length;
  }
  return output + escapeHtml(code.slice(cursor));
}

function highlightJson(code) {
  const pattern = /("(?:\\.|[^"\\])*"\s*:|"(?:\\.|[^"\\])*"|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b|\b(?:true|false|null)\b)/g;
  return code.replace(pattern, token => {
    if (token.trimEnd().endsWith(":")) return `<span class="tok-property">${escapeHtml(token.slice(0, token.lastIndexOf(":")))}</span>:`;
    if (token.startsWith('"')) return `<span class="tok-string">${escapeHtml(token)}</span>`;
    if (/^-?\d/.test(token)) return `<span class="tok-number">${escapeHtml(token)}</span>`;
    return `<span class="tok-keyword">${escapeHtml(token)}</span>`;
  });
}

function highlightMarkup(code) {
  const pattern = /<!--[\s\S]*?-->|<\/?[A-Za-z][^>]*>/g;
  let output = "";
  let cursor = 0;
  for (const match of code.matchAll(pattern)) {
    output += escapeHtml(code.slice(cursor, match.index));
    const token = match[0];
    if (token.startsWith("<!--")) output += `<span class="tok-comment">${escapeHtml(token)}</span>`;
    else output += highlightMarkupTag(token);
    cursor = match.index + token.length;
  }
  return output + escapeHtml(code.slice(cursor));
}

function highlightMarkupTag(tag) {
  const pattern = /(^<\/?)([A-Za-z][\w:-]*)|([A-Za-z_:][\w:.-]*)(?=\s*=)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(\/?>$)/g;
  let output = "";
  let cursor = 0;
  for (const match of tag.matchAll(pattern)) {
    output += escapeHtml(tag.slice(cursor, match.index));
    if (match[2]) output += `${escapeHtml(match[1])}<span class="tok-tag">${escapeHtml(match[2])}</span>`;
    else if (match[3]) output += `<span class="tok-attribute">${escapeHtml(match[3])}</span>`;
    else if (/^["']/.test(match[0])) output += `<span class="tok-string">${escapeHtml(match[0])}</span>`;
    else output += escapeHtml(match[0]);
    cursor = match.index + match[0].length;
  }
  return output + escapeHtml(tag.slice(cursor));
}

function highlightGo(code) { return highlightCode(code, "go"); }

function quickToggleProblem(id) {
  const problem = state.problems.find(item => item.id === id);
  if (!problem) return;
  if (["已完成", "待复习"].includes(problem.status)) problem.status = "未开始";
  else { problem.status = "已完成"; problem.firstSolvedAt ||= localDateTimeValue(new Date()); }
  scheduleSave(); renderProblems(); renderOverview();
}

function openDialog(dialog) { $("#modalBackdrop").hidden = false; dialog.showModal(); }
function closeDialogs() { $$('dialog[open]').forEach(dialog => dialog.close()); $("#modalBackdrop").hidden = true; }

function scheduleSave() {
  if (!state) return;
  clearTimeout(saveTimer);
  showSaveState("正在保存…");
  saveTimer = setTimeout(() => {
    saveTimer = null;
    queueSaveNow().catch(() => {});
  }, 450);
}

function queueSaveNow() {
  savePromise = savePromise.catch(() => false).then(persistState);
  return savePromise;
}

async function persistState() {
  try {
    const response = await fetch("/api/state", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(state) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "保存失败");
    state.updatedAt = result.updatedAt;
    $("#lastSaved").textContent = `上次保存：${formatDateTime(result.updatedAt)}`;
    showSaveState("已保存");
    return true;
  } catch (error) {
    showSaveState("保存失败，请勿关闭");
    showToast("保存失败，请检查本地服务");
    throw error;
  }
}

async function flushPendingSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    return queueSaveNow();
  }
  return savePromise;
}

async function exportHot100Markdown() {
  const button = $("#exportHot100");
  button.disabled = true;
  try {
    await flushPendingSave();
    const response = await fetch("/api/export/hot100.md", { cache: "no-store" });
    if (!response.ok) throw new Error("导出失败");
    const disposition = response.headers.get("Content-Disposition") || "";
    const match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
    const filename = match ? decodeURIComponent(match[1]) : "hot100-notes.md";
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    showToast("Hot 100 思路已导出");
  } catch (error) {
    showToast("导出失败：请确认数据已经保存");
  } finally {
    button.disabled = false;
  }
}

async function importFile(event) {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;
  try {
    const response = await fetch("/api/import", { method: "POST", headers: { "Content-Type": "application/octet-stream", "X-Filename": encodeURIComponent(file.name) }, body: await file.arrayBuffer() });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || "导入失败");
    if (result.kind === "full") {
      state = await (await fetch("/api/state", { cache: "no-store" })).json();
      renderAll(); showToast(`完整备份已恢复，共 ${result.count} 条投递`); return;
    }
    if (!result.count) { showToast("文件中没有识别到投递记录"); return; }
    const mode = state.applications.length && confirm(`识别到 ${result.count} 条记录。\n\n“确定”：追加到现有数据\n“取消”：替换现有投递数据`) ? "append" : "replace";
    state.applications = mode === "append" ? [...state.applications, ...result.applications] : result.applications;
    scheduleSave(); renderAll(); showToast(`已${mode === "append" ? "追加" : "导入"} ${result.count} 条投递记录`);
  } catch (error) { showToast(`导入失败：${error.message}`); }
}

async function testNotification() {
  try {
    const response = await fetch("/api/notify-test", { method: "POST" });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || "未知错误");
    const methodLabels = { "tray-balloon": "Windows 托盘", "macos-notification-center": "macOS 通知中心" };
    showToast(`测试通知已显示（${methodLabels[result.method] || "系统通知"}）`);
  } catch (error) { showToast(`通知失败：${error.message}`); }
}

function syncTopbarForView() {
  const search = $("#contextSearch");
  const globalInput = $("#globalSearch");
  const context = SEARCH_CONTEXTS[currentView];
  search.hidden = !context;
  if (context) {
    const moduleInput = $("#" + context.inputId);
    globalInput.placeholder = context.placeholder;
    globalInput.value = moduleInput.value;
    globalInput.setAttribute("aria-label", context.placeholder);
  } else {
    globalInput.value = "";
  }

  const action = $("#topPrimaryAction");
  action.hidden = !["applications", "reviews"].includes(currentView);
  if (currentView === "applications") action.textContent = "＋ 新增投递";
  if (currentView === "reviews") action.textContent = "＋ 新增复盘";
}

function handleContextSearch(event) {
  const context = SEARCH_CONTEXTS[currentView];
  if (!context) return;
  $("#" + context.inputId).value = event.target.value;
  context.render();
}

function handleModuleSearch(view) {
  const context = SEARCH_CONTEXTS[view];
  if (!context) return;
  if (currentView === view) $("#globalSearch").value = $("#" + context.inputId).value;
  context.render();
}

function handleTopPrimaryAction() {
  if (currentView === "applications") openApplicationDialog();
  if (currentView === "reviews") openReviewDialog();
}

function cycleTheme() {
  const themes = ["auto", "light", "dark"];
  const next = themes[(themes.indexOf(state.settings.theme || "auto") + 1) % themes.length];
  state.settings.theme = next; applyTheme(next); scheduleSave();
  showToast({ auto: "主题：跟随系统", light: "主题：浅色", dark: "主题：深色" }[next]);
}
function applyTheme(theme) {
  const dark = theme === "dark" || (theme === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

function upcomingEvents() {
  const now = new Date(); const horizon = new Date(now); horizon.setDate(horizon.getDate() + 14);
  return state.applications.flatMap(job => [[job.writtenAt, "笔试"], [job.interviewAt, "面试"]].filter(([time]) => time && new Date(time) >= new Date(now.getTime() - 12 * 3600e3) && new Date(time) <= horizon).map(([time, type]) => ({ time, type, company: job.company, position: job.position }))).sort((a, b) => new Date(a.time) - new Date(b.time));
}
function reviewProblems() { return state.problems.filter(item => item.nextReviewAt).sort((a, b) => a.nextReviewAt.localeCompare(b.nextReviewAt)); }
function nextJobEvent(job) { return [[job.writtenAt, "笔试"], [job.interviewAt, "面试"]].filter(([time]) => time).sort((a, b) => a[0].localeCompare(b[0])).map(([time, type]) => ({ time, type }))[0]; }
function isOverdue(value) { return value && new Date(value) < new Date(); }
function isThisWeek(value) { if (!value) return false; const date = new Date(value); const now = new Date(); const start = new Date(now); start.setDate(now.getDate() - ((now.getDay() + 6) % 7)); start.setHours(0, 0, 0, 0); return date >= start; }
function endOfToday() { const date = new Date(); date.setHours(23, 59, 59, 999); return date; }

function statusClass(status) { if (status === "Offer") return "offer"; if (status === "拒绝") return "rejected"; if (["待投递", "暂停"].includes(status)) return "todo"; return ""; }
function priorityClass(priority) { return ({ 高: "high", 中: "medium", 低: "low" }[priority] || "medium"); }
function difficultyClass(value) { return ({ 简单: "easy", 中等: "medium", 困难: "hard" }[value] || "medium"); }
function problemStatusClass(value) { return ({ 已完成: "done", 待复习: "review", 进行中: "progress" }[value] || ""); }
function problemStatusIcon(value) { return ({ 已完成: "✓", 待复习: "↻", 进行中: "•" }[value] || ""); }
function reviewResultClass(value) { return ({ 通过: "pass", 未通过: "fail", 待定: "pending", 主动放弃: "muted" }[value] || "pending"); }
function ratingStars(value) { const count = Math.max(0, Math.min(5, Number(value) || 0)); return `${"★".repeat(count)}${"☆".repeat(5 - count)}`; }
function localDateValue(date) { const offset = date.getTimezoneOffset(); return new Date(date.getTime() - offset * 60000).toISOString().slice(0, 10); }
function localDateTimeValue(date) { const offset = date.getTimezoneOffset(); return new Date(date.getTime() - offset * 60000).toISOString().slice(0, 16); }
function formatDate(value) { if (!value) return "—"; const date = new Date(value); return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(date); }
function formatShort(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(date); }
function formatTime(value) { const date = new Date(value); return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(date); }
function formatDateTime(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(date); }
function monthName(date) { return ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"][date.getMonth()]; }
function dateEyebrow() { const date = new Date(); return `${["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"][date.getDay()]} · ${String(date.getDate()).padStart(2, "0")} ${monthName(date)}`; }
function relativeDate(value) { if (!value) return "未安排"; const target = new Date(value); const today = new Date(); target.setHours(0,0,0,0); today.setHours(0,0,0,0); const days = Math.round((target - today) / 864e5); return days < 0 ? `逾期 ${Math.abs(days)} 天` : days === 0 ? "今天" : days === 1 ? "明天" : `${days} 天后`; }
function emptyMini(icon, title, text) { return `<div class="empty-mini"><div><span>${icon}</span><strong style="display:block;color:var(--text);font-size:12px;margin-top:8px">${title}</strong><p>${text}</p></div></div>`; }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char])); }
function showToast(message) { clearTimeout(toastTimer); const toast = $("#toast"); toast.textContent = message; toast.classList.add("show"); toastTimer = setTimeout(() => toast.classList.remove("show"), 2600); }
function showSaveState(message) { const badge = $("#saveState"); badge.textContent = message; badge.classList.add("visible"); clearTimeout(badge.hideTimer); badge.hideTimer = setTimeout(() => badge.classList.remove("visible"), message === "正在保存…" ? 5000 : 1600); }
