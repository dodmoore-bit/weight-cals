(() => {
  'use strict';

  const STORAGE_KEY = 'wc-track-v1';
  const MEAL_KEYS = ['breakfast', 'lunch', 'dinner'];
  const MEAL_LABELS = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner' };
  const MEAL_INPUT_IDS = { breakfast: 'input-bf', lunch: 'input-lunch', dinner: 'input-dinner' };
  const MEAL_HINT_IDS = { breakfast: 'hint-bf', lunch: 'hint-lunch', dinner: 'hint-dinner' };

  const DEFAULTS = {
    startWeight: null, // set in Data tab or via Import history
    goalCals: 2000,
    tdee: null,
    weights: {},   // { 'YYYY-MM-DD': number }
    calories: {},  // { 'YYYY-MM-DD': { breakfast, lunch, dinner } } — values may be null
    mealParts: {}  // { 'YYYY-MM-DD': { breakfast: number[], lunch: number[], dinner: number[] } }
  };

  // ---- storage ----
  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return structuredClone(DEFAULTS);
      const data = JSON.parse(raw);
      return {
        startWeight: optNum(data.startWeight, DEFAULTS.startWeight),
        goalCals: optNum(data.goalCals, DEFAULTS.goalCals),
        tdee: optNum(data.tdee, DEFAULTS.tdee),
        weights: data.weights && typeof data.weights === 'object' ? data.weights : {},
        calories: data.calories && typeof data.calories === 'object' ? data.calories : {},
        mealParts: normalizeMealParts(data.mealParts)
      };
    } catch {
      return structuredClone(DEFAULTS);
    }
  }

  function normalizeMealParts(raw) {
    if (!raw || typeof raw !== 'object') return {};
    const out = {};
    for (const [date, entry] of Object.entries(raw)) {
      if (!entry || typeof entry !== 'object') continue;
      const day = {};
      for (const meal of MEAL_KEYS) {
        const arr = Array.isArray(entry[meal])
          ? entry[meal].map(Number).filter(n => Number.isFinite(n) && n >= 0).map(n => Math.round(n))
          : [];
        if (arr.length) day[meal] = arr;
      }
      if (Object.keys(day).length) out[date] = day;
    }
    return out;
  }

  function save(state) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function numOr(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  // Like numOr, but null/empty stay "unset" instead of becoming 0.
  function optNum(v, fallback) {
    if (v === null || v === undefined || v === '') return fallback;
    return numOr(v, fallback);
  }

  let state = load();

  // ---- selected day (Today tab can view/edit any past day) ----
  let selectedDay = todayISO();
  let followToday = true; // keep tracking "today" across midnight if the user hasn't picked a day
  let formDirty = false;  // unsaved edits in the Today tab inputs

  function getSelectedDay() {
    const today = todayISO();
    if (followToday) selectedDay = today;
    if (!isISODate(selectedDay) || selectedDay > today) {
      selectedDay = today;
      followToday = true;
    }
    return selectedDay;
  }

  function cleanMeal(v) {
    if (v == null || v === '') return null;
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? n : null;
  }

  /**
   * Merge a history payload ({weights:{date:lbs}, calories:{date:{breakfast,lunch,dinner}}}).
   * preferExisting=true keeps values already on this device; false (Import history)
   * lets the imported file overwrite the same dates.
   */
  function mergeHistoryData(data, { preferExisting = true } = {}) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid history data');
    const hasWeights = data.weights && typeof data.weights === 'object';
    const hasCals = data.calories && typeof data.calories === 'object';
    const hasRows = Array.isArray(data.weightByDate);
    if (!hasWeights && !hasCals && !hasRows) {
      throw new Error('No "weights" or "calories" found');
    }
    let wAdded = 0, cAdded = 0;
    if (!preferExisting || state.startWeight == null) {
      if (data.startWeight != null) state.startWeight = optNum(data.startWeight, state.startWeight);
    }
    if (!preferExisting || state.tdee == null) {
      if (data.tdee != null) state.tdee = optNum(data.tdee, state.tdee);
    }
    if (!preferExisting) {
      if (data.goalCals != null) state.goalCals = optNum(data.goalCals, state.goalCals);
    }
    if (hasWeights) {
      for (const [d, w] of Object.entries(data.weights)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
        if (w === null || w === '') continue;
        const n = Number(w);
        if (!Number.isFinite(n)) continue;
        if (preferExisting && state.weights[d] != null) continue;
        state.weights[d] = Math.round(n * 10) / 10;
        wAdded++;
      }
    }
    if (hasRows) {
      for (const row of data.weightByDate) {
        if (!row || !/^\d{4}-\d{2}-\d{2}$/.test(row.date || '')) continue;
        const n = Number(row.weight);
        if (row.weight == null || !Number.isFinite(n)) continue;
        if (preferExisting && state.weights[row.date] != null) continue;
        state.weights[row.date] = Math.round(n * 10) / 10;
        wAdded++;
      }
    }
    if (hasCals) {
      for (const [d, entry] of Object.entries(data.calories)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
        if (!entry || typeof entry !== 'object') continue;
        if (preferExisting && state.calories[d] != null) continue;
        const b = cleanMeal(entry.breakfast);
        const l = cleanMeal(entry.lunch);
        const di = cleanMeal(entry.dinner);
        if (b == null && l == null && di == null) continue;
        state.calories[d] = { breakfast: b, lunch: l, dinner: di };
        // Imported totals are authoritative; drop stale per-meal parts for that day.
        if (!preferExisting && state.mealParts && state.mealParts[d]) {
          for (const meal of MEAL_KEYS) {
            if (state.calories[d][meal] == null) delete state.mealParts[d][meal];
          }
          if (!Object.keys(state.mealParts[d]).length) delete state.mealParts[d];
        }
        cAdded++;
      }
    }
    if (data.mealParts && typeof data.mealParts === 'object') {
      const incoming = normalizeMealParts(data.mealParts);
      if (!state.mealParts) state.mealParts = {};
      for (const [d, entry] of Object.entries(incoming)) {
        if (preferExisting && state.mealParts[d] != null) continue;
        state.mealParts[d] = entry;
      }
    }
    save(state);
    return { wAdded, cAdded, weightCount: Object.keys(state.weights).length, calCount: Object.keys(state.calories).length };
  }

  // ---- date helpers ----
  function todayISO() {
    // Prefer America/Chicago calendar date for "today"
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Chicago',
        year: 'numeric', month: '2-digit', day: '2-digit'
      }).formatToParts(new Date());
      const y = parts.find(p => p.type === 'year').value;
      const m = parts.find(p => p.type === 'month').value;
      const d = parts.find(p => p.type === 'day').value;
      return `${y}-${m}-${d}`;
    } catch {
      const d = new Date();
      return d.toISOString().slice(0, 10);
    }
  }

  function formatDisplayDate(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    return dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  }

  function isISODate(v) {
    return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
  }

  function addDays(iso, n) {
    const [y, m, d] = iso.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d + n));
    return dt.toISOString().slice(0, 10);
  }

  // "Thu Oct 8" (adds the year if it isn't this year)
  function formatDayLabel(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    const sameYear = String(y) === todayISO().slice(0, 4);
    const wd = dt.toLocaleDateString('en-US', { weekday: 'short' });
    const md = dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return `${wd} ${md}` + (sameYear ? '' : `, ${y}`);
  }

  function formatShort(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return `${m}/${d}`;
  }

  // ---- calories helpers ----
  function mealTotal(entry) {
    if (!entry) return null;
    const vals = [entry.breakfast, entry.lunch, entry.dinner]
      .map(v => (v === null || v === undefined || v === '' ? null : Number(v)))
      .filter(v => v !== null && Number.isFinite(v));
    if (!vals.length) return null;
    return vals.reduce((a, b) => a + b, 0);
  }

  function parseOptionalInt(el) {
    const t = el.value.trim();
    if (t === '') return null;
    const n = Number(t);
    return Number.isFinite(n) ? Math.round(n) : null;
  }

  function parseOptionalFloat(el) {
    const t = el.value.trim();
    if (t === '') return null;
    const n = Number(t);
    return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
  }

  function getDayParts(day) {
    return (state.mealParts && state.mealParts[day]) || {};
  }

  function getMealParts(day, meal) {
    const dayParts = getDayParts(day);
    return Array.isArray(dayParts[meal]) ? dayParts[meal].slice() : [];
  }

  function setMealParts(day, meal, parts) {
    if (!state.mealParts) state.mealParts = {};
    const cleaned = (parts || [])
      .map(Number)
      .filter(n => Number.isFinite(n) && n >= 0)
      .map(n => Math.round(n));
    if (!state.mealParts[day]) state.mealParts[day] = {};
    if (cleaned.length) {
      state.mealParts[day][meal] = cleaned;
    } else {
      delete state.mealParts[day][meal];
      if (!Object.keys(state.mealParts[day]).length) delete state.mealParts[day];
    }
  }

  function formatPartsHint(parts) {
    if (!parts || !parts.length) return '';
    return parts.join(' + ') + ' = ' + parts.reduce((a, b) => a + b, 0);
  }

  // ---- toast ----
  let toastTimer;
  function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
  }

  // ---- meal parts sheet ----
  let partsSheetMeal = null; // 'breakfast' | 'lunch' | 'dinner'
  let partsDraft = [];       // number | '' while editing

  function openPartsSheet(meal) {
    partsSheetMeal = meal;
    const day = getSelectedDay();
    const saved = getMealParts(day, meal);
    if (saved.length) {
      partsDraft = saved.slice();
    } else {
      // seed from current total if present, else one empty row
      const input = document.getElementById(MEAL_INPUT_IDS[meal]);
      const current = parseOptionalInt(input);
      partsDraft = current != null ? [current] : [''];
    }
    document.getElementById('parts-sheet-title').textContent = MEAL_LABELS[meal] + ' parts';
    document.getElementById('parts-sheet-hint').textContent =
      'Add each piece’s kcal (e.g. 280 + 120). Apply fills the ' + MEAL_LABELS[meal].toLowerCase() + ' total.';
    renderPartsList();
    updatePartsSum();
    const backdrop = document.getElementById('parts-backdrop');
    const sheet = document.getElementById('parts-sheet');
    backdrop.hidden = false;
    sheet.hidden = false;
    // focus first empty or last input
    requestAnimationFrame(() => {
      const inputs = sheet.querySelectorAll('.part-row input');
      const empty = [...inputs].find(i => i.value === '');
      (empty || inputs[inputs.length - 1])?.focus();
    });
  }

  function closePartsSheet() {
    partsSheetMeal = null;
    partsDraft = [];
    document.getElementById('parts-backdrop').hidden = true;
    document.getElementById('parts-sheet').hidden = true;
  }

  function draftNumbers() {
    return partsDraft
      .map(v => (v === '' || v == null ? null : Number(v)))
      .filter(n => n !== null && Number.isFinite(n) && n >= 0)
      .map(n => Math.round(n));
  }

  function updatePartsSum() {
    const sum = draftNumbers().reduce((a, b) => a + b, 0);
    document.getElementById('parts-sum').textContent = String(sum);
  }

  function renderPartsList() {
    const list = document.getElementById('parts-list');
    if (!partsDraft.length) partsDraft = [''];
    list.innerHTML = partsDraft.map((val, i) => {
      const display = val === '' || val == null ? '' : String(val);
      return `<div class="part-row" data-idx="${i}">
        <span class="part-num">${i + 1}</span>
        <input type="number" inputmode="numeric" step="1" min="0" max="10000" placeholder="kcal" value="${display}" aria-label="Part ${i + 1} kcal" />
        <button type="button" class="btn-remove-part" data-remove="${i}" aria-label="Remove part ${i + 1}">×</button>
      </div>`;
    }).join('');

    list.querySelectorAll('.part-row input').forEach((input) => {
      input.addEventListener('input', () => {
        const idx = Number(input.closest('.part-row').dataset.idx);
        const t = input.value.trim();
        if (t === '') {
          partsDraft[idx] = '';
        } else {
          const n = Number(t);
          partsDraft[idx] = Number.isFinite(n) ? n : '';
        }
        updatePartsSum();
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          partsDraft.push('');
          renderPartsList();
          updatePartsSum();
          const inputs = list.querySelectorAll('.part-row input');
          inputs[inputs.length - 1]?.focus();
        }
      });
    });
    list.querySelectorAll('[data-remove]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.dataset.remove);
        partsDraft.splice(idx, 1);
        if (!partsDraft.length) partsDraft = [''];
        renderPartsList();
        updatePartsSum();
      });
    });
  }

  function applyPartsSheet() {
    if (!partsSheetMeal) return;
    const meal = partsSheetMeal;
    const day = getSelectedDay();
    const nums = draftNumbers();
    const sum = nums.reduce((a, b) => a + b, 0);
    const input = document.getElementById(MEAL_INPUT_IDS[partsSheetMeal]);
    if (nums.length) {
      setMealParts(day, partsSheetMeal, nums);
      input.value = String(sum);
      formDirty = true;
    } else {
      setMealParts(day, partsSheetMeal, []);
      // leave total as-is if user cleared parts without wanting to wipe total?
      // Clear parts only; keep whatever is in the total field.
    }
    save(state);
    updateMealPartsHints(day);
    closePartsSheet();
    toast(nums.length ? `${MEAL_LABELS[meal]} = ${sum} kcal — tap Save calories` : 'Parts cleared');
  }

  function clearPartsDraft() {
    partsDraft = [''];
    renderPartsList();
    updatePartsSum();
  }

  function updateMealPartsHints(day) {
    for (const meal of MEAL_KEYS) {
      const hint = document.getElementById(MEAL_HINT_IDS[meal]);
      const parts = getMealParts(day, meal);
      if (parts.length) {
        hint.textContent = formatPartsHint(parts);
        hint.hidden = false;
      } else {
        hint.textContent = '';
        hint.hidden = true;
      }
    }
  }

  // ---- UI: today panel ----
  function renderDateBar(day, today) {
    const isToday = day === today;
    const isYesterday = day === addDays(today, -1);
    document.getElementById('date-label').textContent = formatDayLabel(day);
    document.getElementById('date-sub').textContent =
      isToday ? 'Today' : (isYesterday ? 'Yesterday · editing past day' : 'Editing past day');
    document.getElementById('date-bar').classList.toggle('past', !isToday);
    const input = document.getElementById('input-date');
    input.max = today;
    input.value = day;
    document.getElementById('btn-next-day').disabled = isToday;
    document.getElementById('btn-today').hidden = isToday;
    document.getElementById('header-date').textContent =
      isToday ? formatDisplayDate(today) : `Viewing ${formatDisplayDate(day)}`;
    document.getElementById('weight-card-title').textContent =
      isToday ? 'Today’s weight' : `Weight · ${formatDayLabel(day)}`;
    document.getElementById('meals-card-title').textContent =
      isToday ? 'Today’s meals' : `Meals · ${formatDayLabel(day)}`;
    document.getElementById('weight-card-hint').textContent =
      `Amt Lost = start weight − ${isToday ? 'today’s' : 'that day’s'} weight. Clear the box and save to remove it.`;
  }

  function renderToday() {
    const today = todayISO();
    const day = getSelectedDay();
    const isToday = day === today;
    renderDateBar(day, today);

    const w = state.weights[day];
    const hasStart = state.startWeight != null;
    const lost = w != null && hasStart ? Math.round((state.startWeight - w) * 10) / 10 : null;
    const cal = state.calories[day];
    const lostMeta = document.getElementById('stat-lost-meta');
    if (lostMeta) lostMeta.textContent = hasStart ? `vs ${Number(state.startWeight).toFixed(1)} start` : 'set start in Data';
    const total = mealTotal(cal);
    const goal = state.goalCals;
    const diff = total != null ? total - goal : null;

    const sw = document.getElementById('stat-weight');
    sw.textContent = w != null ? w.toFixed(1) : '—';
    document.getElementById('stat-weight-meta').textContent = w != null ? (isToday ? 'lbs today' : `lbs · ${formatShort(day)}`) : 'not logged';

    const sl = document.getElementById('stat-lost');
    if (lost == null) {
      sl.textContent = '—';
      sl.className = 'value';
    } else {
      sl.textContent = (lost >= 0 ? '+' : '') + lost.toFixed(1);
      sl.className = 'value ' + (lost >= 0 ? 'good' : 'bad');
    }

    const sc = document.getElementById('stat-cals');
    sc.textContent = total != null ? String(total) : '—';
    document.getElementById('stat-cals-meta').textContent = `of ${goal} goal`;

    const sd = document.getElementById('stat-diff');
    const sdm = document.getElementById('stat-diff-meta');
    if (diff == null) {
      sd.textContent = '—';
      sd.className = 'value';
      sdm.textContent = 'under / over';
    } else if (diff <= 0) {
      sd.textContent = String(Math.abs(diff));
      sd.className = 'value good';
      sdm.textContent = 'under goal';
    } else {
      sd.textContent = '+' + diff;
      sd.className = 'value bad';
      sdm.textContent = 'over goal';
    }

    // form fields — don't clobber while parts sheet is open
    if (!partsSheetMeal) {
      document.getElementById('input-weight').value = w != null ? w : '';
      document.getElementById('input-bf').value = cal && cal.breakfast != null ? cal.breakfast : '';
      document.getElementById('input-lunch').value = cal && cal.lunch != null ? cal.lunch : '';
      document.getElementById('input-dinner').value = cal && cal.dinner != null ? cal.dinner : '';
      formDirty = false;
    }

    updateMealPartsHints(day);

    const pct = total != null ? Math.min(100, Math.round((total / goal) * 100)) : 0;
    const bar = document.getElementById('cal-progress');
    bar.classList.toggle('over', total != null && total > goal);
    bar.querySelector('span').style.width = (total != null ? pct : 0) + '%';
    document.getElementById('cal-progress-label').textContent =
      `${total != null ? total : 0} / ${goal} kcal` +
      (state.tdee ? ` · Est TDEE ${state.tdee}` : '');
  }

  function selectDay(iso, { force = false } = {}) {
    const today = todayISO();
    if (!isISODate(iso)) return false;
    if (iso > today) {
      iso = today;
      toast('Can’t log future days');
    }
    if (iso === getSelectedDay()) {
      renderToday();
      return true;
    }
    if (!force && formDirty && iso !== selectedDay) {
      if (!confirm(`Discard unsaved changes for ${formatDayLabel(selectedDay)}?`)) {
        renderDateBar(selectedDay, today); // restore picker, keep the typed values
        return false;
      }
    }
    selectedDay = iso;
    followToday = iso === today;
    formDirty = false;
    renderToday();
    return true;
  }

  // ---- charts (simple SVG) ----
  function sortedDates(obj) {
    return Object.keys(obj).sort();
  }

  function drawLineChart(container, points, opts) {
    // points: [{xLabel, y}], opts: {color, goalY?, goalColor?, goalStrokeWidth?, height?, minWidth?, pointGap?,
    //   fontSize?, xFontSize?, yTicks?, strokeWidth?, pointRadius?, gridOpacity?, labelOpacity?, yDecimals?,
    //   trendLine?, trendColor?, omitLastXLabel?}
    container.innerHTML = '';
    if (!points.length) {
      container.innerHTML = '<p class="hint" style="text-align:center;padding:20px">No data yet</p>';
      return;
    }
    // Keep chronological X order when callers pass a date field (oldest → newest).
    if (points[0] && points[0].date != null) {
      points = points.slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
    }
    const fontSize = opts.fontSize != null ? opts.fontSize : 84;
    const xFontSize = opts.xFontSize != null ? opts.xFontSize : fontSize;
    const omitLastXLabel = !!opts.omitLastXLabel;
    const yTicks = opts.yTicks != null ? opts.yTicks : 3;
    const strokeWidth = opts.strokeWidth != null ? opts.strokeWidth : 2.5;
    const pointRadius = opts.pointRadius != null ? opts.pointRadius : 3.5;
    const gridOpacity = opts.gridOpacity != null ? opts.gridOpacity : 0.12;
    const labelOpacity = opts.labelOpacity != null ? opts.labelOpacity : 0.6;
    const yDecimals = opts.yDecimals != null ? opts.yDecimals : 0;
    const pointGap = opts.pointGap != null ? opts.pointGap : 120;
    const minWidth = opts.minWidth != null ? opts.minWidth : 720;
    const H = opts.height != null ? opts.height : 1100;
    const padL = Math.max(48, Math.ceil(fontSize * 3.6));
    const padR = Math.max(20, Math.ceil(fontSize * 1.6));
    const padB = Math.max(36, Math.ceil(fontSize * 2.6));
    const pad = { t: Math.max(20, Math.ceil(fontSize * 1.15)), r: padR, b: padB, l: padL };
    const W = Math.max(minWidth, points.length * pointGap + pad.l + pad.r);
    const iw = W - pad.l - pad.r;
    const ih = H - pad.t - pad.b;
    const ys = points.map(p => p.y);
    if (opts.goalY != null) ys.push(opts.goalY);
    // Ordinary least-squares linear regression on index vs y (even x spacing).
    let trend = null;
    if (opts.trendLine && points.length >= 2) {
      const n = points.length;
      let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
      for (let i = 0; i < n; i++) {
        const y = points[i].y;
        sumX += i;
        sumY += y;
        sumXY += i * y;
        sumXX += i * i;
      }
      const denom = n * sumXX - sumX * sumX;
      if (denom !== 0) {
        const slope = (n * sumXY - sumX * sumY) / denom;
        const intercept = (sumY - slope * sumX) / n;
        trend = { y0: intercept, y1: intercept + slope * (n - 1) };
        ys.push(trend.y0, trend.y1);
      }
    }
    let ymin = Math.min(...ys);
    let ymax = Math.max(...ys);
    if (ymin === ymax) { ymin -= 1; ymax += 1; }
    const padY = (ymax - ymin) * 0.12 || 1;
    ymin -= padY;
    ymax += padY;

    const xAt = (i) => pad.l + (points.length === 1 ? iw / 2 : (i / (points.length - 1)) * iw);
    const yAt = (v) => pad.t + ((ymax - v) / (ymax - ymin)) * ih;

    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${opts.label || 'chart'}">`;
    // grid + Y labels
    for (let g = 0; g <= yTicks; g++) {
      const gy = pad.t + (ih * g) / yTicks;
      svg += `<line x1="${pad.l}" y1="${gy}" x2="${W - pad.r}" y2="${gy}" stroke="currentColor" stroke-opacity="${gridOpacity}" stroke-width="1" />`;
      const val = ymax - ((ymax - ymin) * g) / yTicks;
      svg += `<text x="${pad.l - 8}" y="${gy + fontSize * 0.35}" text-anchor="end" font-size="${fontSize}" fill="currentColor" fill-opacity="${labelOpacity}">${val.toFixed(yDecimals)}</text>`;
    }
    if (opts.goalY != null) {
      const gy = yAt(opts.goalY);
      // Screen pixels (non-scaling) so the goal stays easy to see on a phone
      // inside this large viewBox. Original thin stroke was ~2; 8 was too thick.
      // Midpoint is 5. Callers may override.
      const goalStroke = opts.goalStrokeWidth != null ? opts.goalStrokeWidth : 5;
      svg += `<line x1="${pad.l}" y1="${gy}" x2="${W - pad.r}" y2="${gy}" stroke="${opts.goalColor || '#22c55e'}" stroke-width="${goalStroke}" vector-effect="non-scaling-stroke" stroke-linecap="round" />`;
    }
    if (trend) {
      const tc = opts.trendColor || '#c084fc';
      const tw = Math.max(2, strokeWidth * 0.7);
      svg += `<line x1="${xAt(0).toFixed(1)}" y1="${yAt(trend.y0).toFixed(1)}" x2="${xAt(points.length - 1).toFixed(1)}" y2="${yAt(trend.y1).toFixed(1)}" stroke="${tc}" stroke-width="${tw}" stroke-dasharray="14 10" stroke-linecap="round" />`;
    }
    const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${xAt(i).toFixed(1)},${yAt(p.y).toFixed(1)}`).join(' ');
    svg += `<path d="${path}" fill="none" stroke="${opts.color}" stroke-width="${strokeWidth}" stroke-linejoin="round" stroke-linecap="round" />`;
    // skip some x labels when dense so they stay readable on phone
    const labelEvery = points.length > 18 ? Math.ceil(points.length / 10) : (points.length > 10 ? 2 : 1);
    points.forEach((p, i) => {
      svg += `<circle cx="${xAt(i)}" cy="${yAt(p.y)}" r="${pointRadius}" fill="${opts.color}" />`;
      const isLast = i === points.length - 1;
      // Newest date stays on the right as a point, but its tick label is optional.
      if ((i % labelEvery === 0 || isLast) && !(omitLastXLabel && isLast)) {
        svg += `<text x="${xAt(i)}" y="${H - Math.max(6, fontSize * 0.55)}" text-anchor="middle" font-size="${xFontSize}" fill="currentColor" fill-opacity="${labelOpacity}">${p.xLabel}</text>`;
      }
    });
    svg += '</svg>';
    container.innerHTML = svg;
  }

  function renderWeightHistory() {
    // Ascending by date: oldest on the left, most recent on the right (trend uses same order).
    const dates = sortedDates(state.weights).slice().sort((a, b) => a.localeCompare(b));
    const points = dates.map(d => ({ date: d, xLabel: formatShort(d), y: Number(state.weights[d]) }));
    drawLineChart(document.getElementById('weight-chart'), points, {
      color: '#38bdf8',
      label: 'Weight trend',
      height: 1400,
      minWidth: 320,
      pointGap: 18,
      fontSize: 42,
      xFontSize: 30,
      omitLastXLabel: true,
      yTicks: 5,
      strokeWidth: 5,
      pointRadius: 8,
      gridOpacity: 0.2,
      labelOpacity: 0.72,
      yDecimals: 1,
      trendLine: true,
      trendColor: '#c084fc'
    });

    const countEl = document.getElementById('weight-history-count');
    if (countEl) {
      countEl.textContent = dates.length
        ? `${dates.length} entr${dates.length === 1 ? 'y' : 'ies'}`
        : 'empty';
    }

    const list = document.getElementById('weight-list');
    if (!dates.length) {
      list.innerHTML = '<li class="empty">No weight entries yet</li>';
      return;
    }
    list.innerHTML = dates.slice().reverse().map(d => {
      const w = Number(state.weights[d]);
      let lostStr = '';
      if (state.startWeight != null) {
        const lost = Math.round((state.startWeight - w) * 10) / 10;
        lostStr = (lost >= 0 ? '+' : '') + lost.toFixed(1) + ' lbs lost';
      }
      return `<li data-date="${d}" role="button" tabindex="0" aria-label="Open ${formatDisplayDate(d)}">
        <div class="left"><span class="date">${formatDisplayDate(d)}</span><span class="detail">${lostStr}</span></div>
        <div class="right">${w.toFixed(1)} <span style="color:var(--muted);font-weight:500;font-size:0.8rem">lbs</span></div>
      </li>`;
    }).join('');
  }

  function renderCalsHistory() {
    const dates = sortedDates(state.calories).filter(d => mealTotal(state.calories[d]) != null);
    const points = dates.map(d => ({ xLabel: formatShort(d), y: mealTotal(state.calories[d]) }));
    drawLineChart(document.getElementById('cals-chart'), points, {
      color: '#f59e0b',
      goalY: state.goalCals,
      goalColor: '#22c55e',
      goalStrokeWidth: 2.5,
      label: 'Calorie trend',
      height: 1100,
      minWidth: 900,
      pointGap: 140,
      fontSize: 84,
      yTicks: 5,
      strokeWidth: 5,
      pointRadius: 8,
      gridOpacity: 0.2,
      labelOpacity: 0.72,
      yDecimals: 0
    });

    const allDates = sortedDates(state.calories);
    const countEl = document.getElementById('cals-history-count');
    if (countEl) {
      countEl.textContent = allDates.length
        ? `${allDates.length} entr${allDates.length === 1 ? 'y' : 'ies'}`
        : 'empty';
    }

    const list = document.getElementById('cals-list');
    if (!allDates.length) {
      list.innerHTML = '<li class="empty">No calorie entries yet</li>';
      return;
    }
    list.innerHTML = allDates.slice().reverse().map(d => {
      const e = state.calories[d];
      const t = mealTotal(e);
      const parts = [];
      if (e.breakfast != null) parts.push(`B ${e.breakfast}`);
      if (e.lunch != null) parts.push(`L ${e.lunch}`);
      if (e.dinner != null) parts.push(`D ${e.dinner}`);
      const detail = parts.length ? parts.join(' · ') : 'no meals logged';
      const diff = t != null ? t - state.goalCals : null;
      let rightClass = '';
      let right = '—';
      if (t != null) {
        right = String(t);
        rightClass = diff > 0 ? 'bad' : 'good';
      }
      return `<li data-date="${d}" role="button" tabindex="0" aria-label="Open ${formatDisplayDate(d)}">
        <div class="left"><span class="date">${formatDisplayDate(d)}</span><span class="detail">${detail}</span></div>
        <div class="right ${rightClass}">${right} <span style="color:var(--muted);font-weight:500;font-size:0.8rem">kcal</span></div>
      </li>`;
    }).join('');
  }

  function renderSettings() {
    document.getElementById('cfg-start-weight').value = state.startWeight != null ? state.startWeight : '';
    document.getElementById('cfg-goal-cals').value = state.goalCals != null ? state.goalCals : '';
    document.getElementById('cfg-tdee').value = state.tdee != null ? state.tdee : '';
  }

  function renderAll() {
    renderToday();
    renderWeightHistory();
    renderCalsHistory();
    renderSettings();
  }

  // ---- navigation ----
  function showPanel(name) {
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    document.getElementById('panel-' + name).classList.add('active');
    document.querySelectorAll('.nav button').forEach(b => {
      const on = b.dataset.panel === name;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    if (name === 'weight') renderWeightHistory();
    if (name === 'cals') renderCalsHistory();
    if (name === 'data') renderSettings();
    if (name === 'today') renderToday();
    else document.getElementById('header-date').textContent = formatDisplayDate(todayISO());
  }

  // ---- export / import ----
  function downloadBlob(filename, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportJSON() {
    const payload = {
      exportedAt: new Date().toISOString(),
      startWeight: state.startWeight,
      goalCals: state.goalCals,
      tdee: state.tdee,
      weights: state.weights,
      calories: state.calories,
      mealParts: state.mealParts || {}
    };
    downloadBlob(
      `weight-cals-${todayISO()}.json`,
      new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    );
    toast('JSON exported');
  }

  function exportCSV() {
    const dates = new Set([...Object.keys(state.weights), ...Object.keys(state.calories)]);
    const sorted = [...dates].sort();
    const lines = [
      'Date,Weight_lbs,Amt_Lost,Breakfast,Lunch,Dinner,Total_Calories,Goal_Daily_Cal,Diff_vs_Goal,Est_TDEE'
    ];
    for (const d of sorted) {
      const w = state.weights[d];
      const lost = w != null && state.startWeight != null ? Math.round((state.startWeight - Number(w)) * 10) / 10 : '';
      const c = state.calories[d] || {};
      const bf = c.breakfast != null ? c.breakfast : '';
      const lu = c.lunch != null ? c.lunch : '';
      const di = c.dinner != null ? c.dinner : '';
      const tot = mealTotal(c);
      const diff = tot != null ? tot - state.goalCals : '';
      lines.push([
        d,
        w != null ? w : '',
        lost,
        bf, lu, di,
        tot != null ? tot : '',
        state.goalCals,
        diff,
        state.tdee != null ? state.tdee : ''
      ].join(','));
    }
    downloadBlob(
      `weight-cals-${todayISO()}.csv`,
      new Blob([lines.join('\n')], { type: 'text/csv' })
    );
    toast('CSV exported');
  }

  function showImportStatus(msg, isError) {
    const el = document.getElementById('import-status');
    if (el) {
      el.textContent = msg;
      el.classList.toggle('error', !!isError);
      el.hidden = false;
    }
    toast(msg);
  }

  function importSummary(stats) {
    return `Imported ${stats.wAdded} weight${stats.wAdded === 1 ? '' : 's'}, ` +
      `${stats.cAdded} day${stats.cAdded === 1 ? '' : 's'} of calories`;
  }

  function importText(text, filename) {
    const name = (filename || '').toLowerCase();
    const trimmed = String(text || '').replace(/^\uFEFF/, '').trim();
    if (!trimmed) throw new Error('Nothing to import');
    if (name.endsWith('.csv') || (!name.endsWith('.json') && /^date,/i.test(trimmed))) {
      return importCSV(trimmed);
    }
    return importJSON(trimmed);
  }

  function importJSON(text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error('That isn’t valid JSON');
    }
    // Imported history is the authoritative copy: overwrite matching dates.
    const stats = mergeHistoryData(data, { preferExisting: false });
    renderAll();
    showImportStatus(importSummary(stats));
    return stats;
  }

  function importCSV(text) {
    const lines = text.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
    if (lines.length < 2) throw new Error('CSV empty');
    const header = lines[0].split(',').map(h => h.trim().toLowerCase());
    const idx = (names) => {
      for (const n of names) {
        const i = header.indexOf(n);
        if (i >= 0) return i;
      }
      return -1;
    };
    const iDate = idx(['date']);
    const iW = idx(['weight_lbs', 'weight', 'weight lbs']);
    const iBf = idx(['breakfast']);
    const iLu = idx(['lunch']);
    const iDi = idx(['dinner']);
    if (iDate < 0) throw new Error('CSV needs a Date column');

    let wAdded = 0, cAdded = 0;
    for (let r = 1; r < lines.length; r++) {
      const cols = lines[r].split(',');
      const date = (cols[iDate] || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      if (iW >= 0 && cols[iW] != null && cols[iW].trim() !== '') {
        const w = Number(cols[iW]);
        if (Number.isFinite(w)) { state.weights[date] = Math.round(w * 10) / 10; wAdded++; }
      }
      const hasMeal = (iBf >= 0 || iLu >= 0 || iDi >= 0);
      if (hasMeal) {
        const entry = state.calories[date] || { breakfast: null, lunch: null, dinner: null };
        const read = (i) => {
          if (i < 0) return null;
          const t = (cols[i] || '').trim();
          if (t === '') return null;
          const n = Number(t);
          return Number.isFinite(n) ? Math.round(n) : null;
        };
        if (iBf >= 0) entry.breakfast = read(iBf);
        if (iLu >= 0) entry.lunch = read(iLu);
        if (iDi >= 0) entry.dinner = read(iDi);
        if (entry.breakfast != null || entry.lunch != null || entry.dinner != null) {
          state.calories[date] = entry;
          cAdded++;
        }
      }
    }
    save(state);
    renderAll();
    const stats = { wAdded, cAdded };
    showImportStatus(importSummary(stats));
    return stats;
  }


  // ---- events ----
  document.querySelectorAll('.nav button').forEach(btn => {
    btn.addEventListener('click', () => showPanel(btn.dataset.panel));
  });

  document.getElementById('btn-save-weight').addEventListener('click', () => {
    const day = getSelectedDay();
    const label = day === todayISO() ? '' : ` for ${formatDayLabel(day)}`;
    const w = parseOptionalFloat(document.getElementById('input-weight'));
    if (w == null) {
      if (state.weights[day] != null) {
        delete state.weights[day];
        save(state);
        renderAll();
        toast('Weight cleared' + label);
      } else {
        toast('Enter a weight');
      }
      return;
    }
    state.weights[day] = w;
    save(state);
    renderAll();
    toast('Weight saved' + label);
  });

  document.getElementById('btn-save-cals').addEventListener('click', () => {
    const day = getSelectedDay();
    const label = day === todayISO() ? '' : ` for ${formatDayLabel(day)}`;
    const breakfast = parseOptionalInt(document.getElementById('input-bf'));
    const lunch = parseOptionalInt(document.getElementById('input-lunch'));
    const dinner = parseOptionalInt(document.getElementById('input-dinner'));
    if (breakfast == null && lunch == null && dinner == null) {
      // allow clearing
      delete state.calories[day];
      if (state.mealParts) delete state.mealParts[day];
    } else {
      state.calories[day] = { breakfast, lunch, dinner };
      // drop parts for meals that no longer have a total
      for (const meal of MEAL_KEYS) {
        const total = meal === 'breakfast' ? breakfast : meal === 'lunch' ? lunch : dinner;
        if (total == null) setMealParts(day, meal, []);
      }
    }
    save(state);
    renderAll();
    toast((breakfast == null && lunch == null && dinner == null ? 'Calories cleared' : 'Calories saved') + label);
  });

  document.getElementById('btn-save-cfg').addEventListener('click', () => {
    const sw = parseOptionalFloat(document.getElementById('cfg-start-weight'));
    const gc = parseOptionalInt(document.getElementById('cfg-goal-cals'));
    const td = parseOptionalInt(document.getElementById('cfg-tdee'));
    if (sw != null) state.startWeight = sw;
    if (gc != null) state.goalCals = gc;
    if (td != null) state.tdee = td;
    save(state);
    renderAll();
    toast('Settings saved');
  });

  document.getElementById('btn-export-json').addEventListener('click', exportJSON);
  document.getElementById('btn-export-csv').addEventListener('click', exportCSV);

  document.getElementById('btn-import').addEventListener('click', () => {
    document.getElementById('import-file').click();
  });
  document.getElementById('import-file').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        importText(String(reader.result), file.name);
      } catch (err) {
        console.error(err);
        showImportStatus('Import failed: ' + (err.message || 'bad file'), true);
      }
    };
    reader.onerror = () => showImportStatus('Import failed: could not read file', true);
    reader.readAsText(file);
  });

  document.getElementById('btn-import-paste').addEventListener('click', () => {
    const box = document.getElementById('import-text');
    try {
      importText(box.value, '');
      box.value = '';
    } catch (err) {
      console.error(err);
      showImportStatus('Import failed: ' + (err.message || 'bad JSON'), true);
    }
  });

  document.getElementById('btn-clear').addEventListener('click', () => {
    if (!confirm('Clear all weight and calorie data on this device?')) return;
    localStorage.removeItem(STORAGE_KEY);
    state = structuredClone(DEFAULTS);
    save(state);
    renderAll();
    toast('Data cleared');
  });


  // Date selector
  document.getElementById('btn-prev-day').addEventListener('click', () => selectDay(addDays(getSelectedDay(), -1)));
  document.getElementById('btn-next-day').addEventListener('click', () => selectDay(addDays(getSelectedDay(), 1)));
  document.getElementById('btn-today').addEventListener('click', () => selectDay(todayISO()));
  const dateInput = document.getElementById('input-date');
  dateInput.addEventListener('change', () => {
    if (isISODate(dateInput.value)) selectDay(dateInput.value);
    else renderToday();
  });
  // Some desktop browsers need showPicker() for the overlaid input to open on click.
  dateInput.addEventListener('click', () => {
    try { if (typeof dateInput.showPicker === 'function') dateInput.showPicker(); } catch { /* ignore */ }
  });
  ['input-weight', 'input-bf', 'input-lunch', 'input-dinner'].forEach(id => {
    document.getElementById(id).addEventListener('input', () => { formDirty = true; });
  });

  // Tap a history row -> open that day on the Today tab
  ['weight-list', 'cals-list'].forEach(id => {
    const list = document.getElementById(id);
    const open = (li) => {
      if (!li || !li.dataset.date) return;
      if (selectDay(li.dataset.date)) {
        showPanel('today');
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    };
    list.addEventListener('click', (e) => open(e.target.closest('li[data-date]')));
    list.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        const li = e.target.closest('li[data-date]');
        if (li) { e.preventDefault(); open(li); }
      }
    });
  });

  // Roll over to the new day if the app is left open past midnight.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !formDirty && !partsSheetMeal) renderToday();
  });

  // Parts sheet controls
  document.querySelectorAll('[data-open-parts]').forEach(btn => {
    btn.addEventListener('click', () => openPartsSheet(btn.dataset.openParts));
  });
  document.getElementById('parts-backdrop').addEventListener('click', closePartsSheet);
  document.getElementById('parts-cancel').addEventListener('click', closePartsSheet);
  document.getElementById('parts-add').addEventListener('click', () => {
    partsDraft.push('');
    renderPartsList();
    updatePartsSum();
    const inputs = document.querySelectorAll('#parts-list .part-row input');
    inputs[inputs.length - 1]?.focus();
  });
  document.getElementById('parts-clear').addEventListener('click', clearPartsDraft);
  document.getElementById('parts-apply').addEventListener('click', applyPartsSheet);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && partsSheetMeal) closePartsSheet();
  });


  // ---- service worker ----
  if ('serviceWorker' in navigator) {
    const hadController = !!navigator.serviceWorker.controller;
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      // A new version just activated; reload once so the new code is used
      // (skip if there's unsaved input).
      if (!hadController || reloading || formDirty || partsSheetMeal) return;
      reloading = true;
      window.location.reload();
    });
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').then((reg) => {
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') reg.update().catch(() => {});
        });
      }).catch(() => {});
    });
  }

  renderAll();
})();
