(function () {
  'use strict';

  var CONFIG = {
    sheetId: '1iqP9ThZtAwmCMfyvQZT06wWEuLFgrvC_olwo_ACFCeI',
    sheetName: 'Database',
    snapshotUrl: 'data/snapshot.json',
    urgency: { baru: 7, perhatian: 14 }, // days thresholds: <baru, baru<=x<perhatian, >=perhatian kritis
    pageSize: 20
  };
  CONFIG.liveUrl = 'https://docs.google.com/spreadsheets/d/' + CONFIG.sheetId +
    '/gviz/tq?tqx=out:csv&sheet=' + encodeURIComponent(CONFIG.sheetName) + '&cb=' + Date.now();

  var MONTHS_ID = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

  var state = {
    records: [],
    source: 'loading', // loading | snapshot | live | error
    lastUpdatedLabel: '',
    urgencyFilter: 'all',
    search: '',
    statusFilter: 'all',
    tindakFilter: 'all',
    sort: { key: 'tglVerifikasi', dir: 'desc' },
    page: 1,
    priorityShown: 12,
    trendFrom: null,
    trendTo: null,
    trendVisible: { ok: true, warn: true, total: true }
  };

  var lastTrendDays = [];
  var lastCumDays = [];
  var lastHistBuckets = [];
  var tooltipEl = null;

  // ---------- CSV parsing ----------
  function parseCSV(text) {
    var rows = [];
    var row = [];
    var field = '';
    var inQuotes = false;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else { inQuotes = false; }
        } else {
          field += c;
        }
      } else if (c === '"') {
        inQuotes = true;
      } else if (c === ',') {
        row.push(field); field = '';
      } else if (c === '\r') {
        // ignore, \n handles line break
      } else if (c === '\n') {
        row.push(field); rows.push(row); row = []; field = '';
      } else {
        field += c;
      }
    }
    if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
    return rows;
  }

  function cleanVal(v) {
    if (v == null) return null;
    var t = String(v).trim();
    if (t === '' || t === '-' || t === "-'") return null;
    return t;
  }
  function boolVal(v) { return String(v || '').trim().toUpperCase() === 'TRUE'; }

  function rowsToRecords(allRows) {
    var dataRows = allRows.slice(3).filter(function (r) { return r && r[0] && String(r[0]).trim(); });
    return dataRows.map(function (r) {
      return {
        noKK: String(r[0] || '').trim(),
        nama: String(r[1] || '').trim(),
        nomorHp: cleanVal(r[2]),
        statusKK: cleanVal(r[3]) || '',
        tglSubmit: cleanVal(r[4]),
        statusVerifikasi: cleanVal(r[5]) || '',
        tglVerifikasi: cleanVal(r[6]),
        desilSaatIni: cleanVal(r[7]),
        versiSaatIni: cleanVal(r[8]),
        desilSebelumnya: cleanVal(r[9]),
        versiSebelumnya: cleanVal(r[10]),
        kirimWA: boolVal(r[11]),
        tidakTerdaftarWA: boolVal(r[12]),
        bedaFormat: boolVal(r[13]),
        catatanPerbaikan: String(r[16] || '').trim(),
        hasilPemutakhiran: cleanVal(r[17]) || '',
        tindakLanjut: cleanVal(r[18]) || ''
      };
    });
  }

  // ---------- date helpers ----------
  function parseSheetDateTime(s) {
    if (!s) return null;
    var parts = s.split(' ');
    var datePart = parts[0], timePart = parts[1];
    var dp = datePart.split('-').map(Number);
    var hh = 0, mm = 0;
    if (timePart) {
      var tp = timePart.split('.').map(Number);
      hh = tp[0] || 0; mm = tp[1] || 0;
    }
    return new Date(dp[0], dp[1] - 1, dp[2], hh, mm);
  }
  function dateOnlyKey(s) { return s ? s.split(' ')[0] : null; }
  function parseDateOnly(key) {
    var p = key.split('-').map(Number);
    return new Date(p[0], p[1] - 1, p[2]);
  }
  function toDateKey(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function formatDateID(key) {
    if (!key) return '–';
    var p = key.split('-').map(Number);
    return p[2] + ' ' + MONTHS_ID[p[1] - 1] + ' ' + p[0];
  }
  function stripTimeFromLabel(label) {
    if (!label) return '';
    return label.replace(/\s+\d{1,2}[:.]\d{2}\s*$/, '').trim();
  }

  // ---------- masking ----------
  function maskNoKK(noKK) {
    if (!noKK) return '–';
    if (noKK.length <= 8) return noKK.slice(0, 1) + '•'.repeat(Math.max(noKK.length - 2, 1)) + noKK.slice(-1);
    return noKK.slice(0, 4) + ' •••• •••• ' + noKK.slice(-4);
  }
  function maskPhone(phone) {
    if (!phone) return 'Tidak ada nomor';
    var digits = phone.replace(/\D/g, '');
    if (digits.length <= 5) return '•'.repeat(digits.length);
    return digits.slice(0, 3) + '••••' + digits.slice(-2);
  }

  // ---------- derive ----------
  function deriveFields(records) {
    var now = new Date();
    records.forEach(function (r) {
      r._submitKey = dateOnlyKey(r.tglSubmit);
      r._verifKey = dateOnlyKey(r.tglVerifikasi);
      r._terjangkauWA = !!(r.nomorHp && !r.tidakTerdaftarWA);

      r._hariMenunggu = null;
      r._urgency = null;
      if (r.tindakLanjut && TINDAK_RANK[r.tindakLanjut] != null && r.tglVerifikasi) {
        var verifDate = parseSheetDateTime(r.tglVerifikasi);
        var days = Math.max(0, Math.floor((now - verifDate) / 86400000));
        r._hariMenunggu = days;
        if (r.tindakLanjut === 'SIAP DICEK ULANG') {
          r._urgency = 'cek';
        } else if (r.tindakLanjut === 'SEDANG DIPERBAIKI') {
          r._urgency = 'progress';
        } else if (days >= CONFIG.urgency.perhatian) {
          r._urgency = 'kritis';
        } else if (days >= CONFIG.urgency.baru) {
          r._urgency = 'perhatian';
        } else {
          r._urgency = 'baru';
        }
      }
    });
    return records;
  }

  // ---------- data loading ----------
  function loadSnapshot() {
    return fetch(CONFIG.snapshotUrl, { cache: 'no-store' })
      .then(function (res) { if (!res.ok) throw new Error('snapshot http ' + res.status); return res.json(); })
      .then(function (json) {
        state.records = deriveFields(json.records || []);
        state.source = 'snapshot';
        state.lastUpdatedLabel = stripTimeFromLabel(json.meta && json.meta.lastUpdatedLabel);
        renderAll();
      });
  }

  function loadLive() {
    setSyncState('loading', 'Menyinkronkan…');
    return fetch(CONFIG.liveUrl, { cache: 'no-store' })
      .then(function (res) { if (!res.ok) throw new Error('live http ' + res.status); return res.text(); })
      .then(function (text) {
        var rows = parseCSV(text);
        if (!rows.length || !rows[0] || !rows[0][1]) throw new Error('format tidak dikenali');
        var records = deriveFields(rowsToRecords(rows));
        if (!records.length) throw new Error('data kosong');
        state.records = records;
        state.source = 'live';
        state.lastUpdatedLabel = stripTimeFromLabel(rows[0][1]);
        hideBanner();
        renderAll();
      })
      .catch(function (err) {
        state.source = state.records.length ? 'snapshot-stale' : 'error';
        showBanner(
          state.records.length
            ? 'Gagal memuat data terbaru dari Google Sheets. Menampilkan data snapshot per ' + (state.lastUpdatedLabel || '-') + '.'
            : 'Gagal memuat data. Periksa koneksi internet atau akses ke spreadsheet.',
          'warn'
        );
        renderSyncIndicator();
        console.error('Live fetch failed:', err);
      });
  }

  function refresh() { loadLive(); }

  // ---------- sync UI ----------
  function setSyncState(stateName, label) {
    var dot = document.getElementById('syncDot');
    var lbl = document.getElementById('syncLabel');
    dot.setAttribute('data-state', stateName);
    lbl.textContent = label;
  }
  function renderSyncIndicator() {
    if (state.source === 'live') {
      setSyncState('live', 'Live · ' + formatHumanLabel(state.lastUpdatedLabel));
    } else if (state.source === 'snapshot') {
      setSyncState('snapshot', 'Snapshot · ' + formatHumanLabel(state.lastUpdatedLabel));
    } else if (state.source === 'snapshot-stale') {
      setSyncState('error', 'Snapshot (offline) · ' + formatHumanLabel(state.lastUpdatedLabel));
    } else if (state.source === 'error') {
      setSyncState('error', 'Gagal memuat data');
    } else {
      setSyncState('loading', 'Memuat data…');
    }
  }
  function formatHumanLabel(label) { return label || '-'; }

  function showBanner(message, tone) {
    var el = document.getElementById('dataBanner');
    el.innerHTML = message + ' <button type="button" id="bannerRetry">Coba lagi</button>';
    el.setAttribute('data-tone', tone || 'warn');
    el.hidden = false;
    document.getElementById('bannerRetry').addEventListener('click', refresh);
  }
  function hideBanner() {
    var el = document.getElementById('dataBanner');
    el.hidden = true;
  }

  // ---------- KPI ----------
  function renderKPIs(records) {
    var total = records.length;
    var sesuai = records.filter(function (r) { return r.statusVerifikasi === 'SESUAI'; }).length;
    var perlu = records.filter(function (r) { return r.statusVerifikasi === 'PERLU DIPERBAIKI'; }).length;
    var menunggu = records.filter(function (r) { return r.tindakLanjut === 'MENUNGGU RESPON'; }).length;
    var sedang = records.filter(function (r) { return r.tindakLanjut === 'SEDANG DIPERBAIKI'; }).length;
    var siapCek = records.filter(function (r) { return r.tindakLanjut === 'SIAP DICEK ULANG'; }).length;
    var takTerjangkau = records.filter(function (r) { return r.tindakLanjut && !r._terjangkauWA; }).length;

    document.getElementById('kpiTotal').textContent = total;
    document.getElementById('kpiSesuai').textContent = sesuai;
    document.getElementById('kpiPerlu').textContent = perlu;
    document.getElementById('kpiMenunggu').textContent = menunggu;
    document.getElementById('kpiSedang').textContent = sedang;
    document.getElementById('kpiSiapCek').textContent = siapCek;
    document.getElementById('kpiTakTerjangkau').textContent = takTerjangkau;
  }

  // ---------- priority list ----------
  var URGENCY_ORDER = { cek: 0, kritis: 1, perhatian: 2, baru: 3, progress: 4 };
  var URGENCY_LABEL = { cek: 'Siap Dicek Ulang', kritis: 'Kritis', perhatian: 'Perhatian', baru: 'Baru', progress: 'Sedang Diperbaiki' };

  function getPriorityRecords() {
    return state.records
      .filter(function (r) { return r._urgency; })
      .filter(function (r) { return state.urgencyFilter === 'all' || r._urgency === state.urgencyFilter; })
      .sort(function (a, b) {
        var oa = URGENCY_ORDER[a._urgency], ob = URGENCY_ORDER[b._urgency];
        if (oa !== ob) return oa - ob;
        return b._hariMenunggu - a._hariMenunggu;
      });
  }

  function renderPriority() {
    var all = getPriorityRecords();
    var shown = all.slice(0, state.priorityShown);
    var container = document.getElementById('priorityList');

    if (!all.length) {
      container.innerHTML = '<div class="empty-state">Tidak ada kasus pada kategori ini.</div>';
      document.getElementById('priorityMoreBtn').hidden = true;
      return;
    }

    container.innerHTML = shown.map(function (r) {
      var waLabel = r._terjangkauWA ? 'Terjangkau WA' : (r.nomorHp ? 'Tidak terdaftar WA' : 'Tidak ada nomor HP');
      var note = r.catatanPerbaikan ? '<div class="priority-note">“' + escapeHtml(r.catatanPerbaikan) + '”</div>' : '';
      return (
        '<div class="priority-card" data-urgency="' + r._urgency + '">' +
          '<div class="priority-days num">' + r._hariMenunggu + '<small>hari</small></div>' +
          '<div>' +
            '<div class="priority-name">' + escapeHtml(r.nama) + '</div>' +
            '<div class="priority-meta">No KK <span class="num">' + maskNoKK(r.noKK) + '</span> · Diverifikasi <span class="num">' + formatDateID(r._verifKey) + '</span> · ' + waLabel + '</div>' +
            note +
          '</div>' +
          '<div class="priority-badge" data-tone="' + r._urgency + '">' + URGENCY_LABEL[r._urgency] + '</div>' +
        '</div>'
      );
    }).join('');

    document.getElementById('priorityMoreBtn').hidden = shown.length >= all.length;
  }

  // ---------- chart tooltip ----------
  function initTooltip() { tooltipEl = document.getElementById('chartTooltip'); }
  function showTooltip(x, y, html) {
    tooltipEl.innerHTML = html;
    tooltipEl.style.left = x + 'px';
    tooltipEl.style.top = y + 'px';
    tooltipEl.hidden = false;
  }
  function hideTooltip() { if (tooltipEl) tooltipEl.hidden = true; }

  function attachChartHover(svgEl, getDataFn, formatFn) {
    svgEl.addEventListener('mousemove', function (e) {
      var group = e.target.closest('[data-idx]');
      if (!group) { hideTooltip(); return; }
      var idx = parseInt(group.getAttribute('data-idx'), 10);
      var data = getDataFn();
      var item = data[idx];
      if (!item) { hideTooltip(); return; }
      showTooltip(e.clientX, e.clientY, formatFn(item));
    });
    svgEl.addEventListener('mouseleave', hideTooltip);
  }

  // ---------- trend chart ----------
  function getVerifDateBounds() {
    var keys = state.records.map(function (r) { return r._verifKey; }).filter(Boolean).sort();
    return { min: keys[0] || null, max: keys[keys.length - 1] || null };
  }

  function renderTrend() {
    var svg = document.getElementById('trendChart');
    var bounds = getVerifDateBounds();
    if (!bounds.min) {
      svg.innerHTML = ''; lastTrendDays = [];
      document.getElementById('cumChart').innerHTML = ''; lastCumDays = [];
      return;
    }

    if (!state.trendFrom) state.trendFrom = bounds.min;
    if (!state.trendTo) state.trendTo = bounds.max;
    if (state.trendFrom > state.trendTo) {
      var tmp = state.trendFrom; state.trendFrom = state.trendTo; state.trendTo = tmp;
    }

    var fromInput = document.getElementById('trendFrom');
    var toInput = document.getElementById('trendTo');
    fromInput.min = bounds.min; fromInput.max = bounds.max; fromInput.value = state.trendFrom;
    toInput.min = bounds.min; toInput.max = bounds.max; toInput.value = state.trendTo;

    var map = {};
    state.records.forEach(function (r) {
      if (!r._verifKey) return;
      if (r._verifKey < state.trendFrom || r._verifKey > state.trendTo) return;
      if (!map[r._verifKey]) map[r._verifKey] = { ok: 0, warn: 0 };
      if (r.statusVerifikasi === 'SESUAI') map[r._verifKey].ok++;
      else if (r.statusVerifikasi === 'PERLU DIPERBAIKI') map[r._verifKey].warn++;
    });

    var minDate = parseDateOnly(state.trendFrom);
    var maxDate = parseDateOnly(state.trendTo);
    var days = [];
    for (var d = new Date(minDate); d <= maxDate; d.setDate(d.getDate() + 1)) {
      var key = toDateKey(d);
      var bucket = map[key] || { ok: 0, warn: 0 };
      days.push({
        key: key,
        ok: state.trendVisible.ok ? bucket.ok : 0,
        warn: state.trendVisible.warn ? bucket.warn : 0,
        okReal: bucket.ok,
        warnReal: bucket.warn
      });
    }

    var maxTotal = Math.max.apply(null, days.map(function (x) { return x.ok + x.warn; }).concat([1]));
    var barW = 13, gap = 6;
    var chartH = 160, padTop = 10, padBottom = 24, padLeft = 4, padRight = 10;
    var width = padLeft + days.length * (barW + gap) + padRight;
    var height = padTop + chartH + padBottom;

    var svgParts = ['<line class="trend-axis-line" x1="' + padLeft + '" y1="' + (padTop + chartH) + '" x2="' + (width - padRight) + '" y2="' + (padTop + chartH) + '"></line>'];

    days.forEach(function (dayData, i) {
      var x = padLeft + i * (barW + gap);
      var okH = (dayData.ok / maxTotal) * chartH;
      var warnH = (dayData.warn / maxTotal) * chartH;
      var yBase = padTop + chartH;
      var yOk = yBase - okH;
      var yWarn = yOk - warnH;
      svgParts.push('<g class="chart-bar-group" data-idx="' + i + '">' +
        '<rect class="chart-hit" x="' + x + '" y="' + padTop + '" width="' + barW + '" height="' + chartH + '" fill="transparent"></rect>' +
        (dayData.ok > 0 ? '<rect class="trend-bar-ok" x="' + x + '" y="' + yOk + '" width="' + barW + '" height="' + Math.max(okH, 1) + '" rx="1.5"></rect>' : '') +
        (dayData.warn > 0 ? '<rect class="trend-bar-warn" x="' + x + '" y="' + yWarn + '" width="' + barW + '" height="' + Math.max(warnH, 1) + '" rx="1.5"></rect>' : '') +
        '</g>');
      if ((i % 4 === 0 && i < days.length - 3) || i === days.length - 1) {
        var p = dayData.key.split('-');
        svgParts.push('<text class="trend-axis-label" x="' + (x + barW / 2) + '" y="' + (padTop + chartH + 15) + '" text-anchor="middle">' + p[2] + '/' + p[1] + '</text>');
      }
    });

    svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
    svg.setAttribute('width', width);
    svg.setAttribute('height', height);
    svg.innerHTML = svgParts.join('');
    lastTrendDays = days;
    renderCumulative(days, { barW: barW, gap: gap, padLeft: padLeft });
  }

  // ---------- cumulative line chart (shares x-axis with the daily bars) ----------
  var CUM_SERIES = ['total', 'warn', 'ok']; // draw order: total at the back

  function niceCeil(v) {
    if (v <= 0) return 1;
    var p = Math.pow(10, Math.floor(Math.log10(v)));
    var n = v / p;
    var steps = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
    for (var i = 0; i < steps.length; i++) if (n <= steps[i]) return steps[i] * p;
    return 10 * p;
  }

  function renderCumulative(days, layout) {
    var svg = document.getElementById('cumChart');
    if (!days.length) { svg.innerHTML = ''; lastCumDays = []; return; }

    // start from everything verified before the selected range, so the line is truly cumulative
    var base = { ok: 0, warn: 0 };
    state.records.forEach(function (r) {
      if (!r._verifKey || r._verifKey >= state.trendFrom) return;
      if (r.statusVerifikasi === 'SESUAI') base.ok++;
      else if (r.statusVerifikasi === 'PERLU DIPERBAIKI') base.warn++;
    });

    var ok = base.ok, warn = base.warn;
    var cum = days.map(function (d) {
      ok += d.okReal; warn += d.warnReal;
      return { key: d.key, ok: ok, warn: warn, total: ok + warn, okDay: d.okReal, warnDay: d.warnReal };
    });

    var visible = CUM_SERIES.filter(function (k) { return state.trendVisible[k]; });
    var last = cum[cum.length - 1];
    var yMax = niceCeil(Math.max.apply(null, visible.map(function (k) { return last[k]; }).concat([1])));

    var barW = layout.barW, gap = layout.gap, padLeft = layout.padLeft;
    var chartH = 150, padTop = 14, padBottom = 24, padRight = 40;
    var width = padLeft + days.length * (barW + gap) + padRight;
    var height = padTop + chartH + padBottom;
    var yBase = padTop + chartH;
    function xAt(i) { return padLeft + i * (barW + gap) + barW / 2; }
    function yAt(v) { return yBase - (v / yMax) * chartH; }

    var parts = [];
    [0, yMax / 2, yMax].forEach(function (t) {
      var y = yAt(t);
      parts.push('<line class="' + (t === 0 ? 'trend-axis-line' : 'cum-grid') + '" x1="' + padLeft + '" y1="' + y + '" x2="' + (width - padRight) + '" y2="' + y + '"></line>');
      if (t > 0) parts.push('<text class="trend-axis-label" x="' + (padLeft + 2) + '" y="' + (y - 3) + '">' + Math.round(t) + '</text>');
    });

    cum.forEach(function (c, i) {
      var x = xAt(i);
      parts.push('<g class="chart-bar-group" data-idx="' + i + '">' +
        '<rect class="chart-hit" x="' + (x - (barW + gap) / 2) + '" y="' + padTop + '" width="' + (barW + gap) + '" height="' + chartH + '" fill="transparent"></rect>' +
        '<line class="cum-guide" x1="' + x + '" y1="' + padTop + '" x2="' + x + '" y2="' + yBase + '"></line>' +
        '</g>');
      if ((i % 4 === 0 && i < cum.length - 3) || i === cum.length - 1) {
        var p = c.key.split('-');
        parts.push('<text class="trend-axis-label" x="' + x + '" y="' + (yBase + 15) + '" text-anchor="middle">' + p[2] + '/' + p[1] + '</text>');
      }
    });

    visible.forEach(function (k) {
      var pts = cum.map(function (c, i) { return xAt(i).toFixed(1) + ',' + yAt(c[k]).toFixed(1); }).join(' ');
      var lx = xAt(cum.length - 1), ly = yAt(last[k]);
      parts.push('<polyline class="cum-line" data-series="' + k + '" points="' + pts + '" pointer-events="none"></polyline>');
      parts.push('<circle class="cum-dot" data-series="' + k + '" cx="' + lx + '" cy="' + ly + '" r="3" pointer-events="none"></circle>');
      parts.push('<text class="cum-end-label" data-series="' + k + '" x="' + (lx + 6) + '" y="' + (ly + 3.5) + '">' + last[k] + '</text>');
    });

    svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
    svg.setAttribute('width', width);
    svg.setAttribute('height', height);
    svg.innerHTML = parts.join('');
    lastCumDays = cum;

    // show the latest dates first; older days are reachable by scrolling left
    var scroller = svg.closest('.trend-scroll');
    scroller.scrollLeft = scroller.scrollWidth;
  }

  function formatCumTooltip(c) {
    return '<div class="tt-title">' + formatDateID(c.key) + '</div>' +
      'Total kumulatif: ' + c.total + '<br>' +
      'Sesuai: ' + c.ok + ' (+' + c.okDay + ')<br>' +
      'Perlu Diperbaiki: ' + c.warn + ' (+' + c.warnDay + ')';
  }

  function formatTrendTooltip(d) {
    return '<div class="tt-title">' + formatDateID(d.key) + '</div>Sesuai: ' + d.okReal + '<br>Perlu Diperbaiki: ' + d.warnReal;
  }

  // ---------- histogram: distribusi lama menunggu ----------
  function computeHistogramBuckets() {
    var records = state.records.filter(function (r) { return r.tindakLanjut === 'MENUNGGU RESPON' && r._hariMenunggu != null; });
    if (!records.length) return [];
    var bucketSize = 7;
    var maxDays = Math.max.apply(null, records.map(function (r) { return r._hariMenunggu; }));
    var bucketCount = Math.floor(maxDays / bucketSize) + 1;
    var buckets = [];
    for (var i = 0; i < bucketCount; i++) {
      var start = i * bucketSize;
      buckets.push({ start: start, end: start + bucketSize - 1, count: 0 });
    }
    records.forEach(function (r) {
      var idx = Math.min(Math.floor(r._hariMenunggu / bucketSize), bucketCount - 1);
      buckets[idx].count++;
    });
    buckets.forEach(function (b) {
      b.label = b.start + '–' + b.end + ' hari';
      if (b.start >= CONFIG.urgency.perhatian) b.tone = 'kritis';
      else if (b.start >= CONFIG.urgency.baru) b.tone = 'perhatian';
      else b.tone = 'baru';
    });
    return buckets;
  }

  function renderHistogram() {
    var svg = document.getElementById('histChart');
    var buckets = computeHistogramBuckets();
    if (!buckets.length) {
      svg.innerHTML = '';
      lastHistBuckets = [];
      return;
    }
    var maxCount = Math.max.apply(null, buckets.map(function (b) { return b.count; }).concat([1]));
    var barW = 34, gap = 14;
    var chartH = 150, padTop = 16, padBottom = 28, padLeft = 6, padRight = 10;
    var width = padLeft + buckets.length * (barW + gap) + padRight;
    var height = padTop + chartH + padBottom;

    var svgParts = ['<line class="trend-axis-line" x1="' + padLeft + '" y1="' + (padTop + chartH) + '" x2="' + (width - padRight) + '" y2="' + (padTop + chartH) + '"></line>'];

    buckets.forEach(function (b, i) {
      var x = padLeft + i * (barW + gap);
      var h = (b.count / maxCount) * chartH;
      var y = padTop + chartH - h;
      svgParts.push('<g class="chart-bar-group" data-idx="' + i + '">' +
        '<rect class="chart-hit" x="' + x + '" y="' + padTop + '" width="' + barW + '" height="' + chartH + '" fill="transparent"></rect>' +
        (b.count > 0 ? '<rect class="hist-bar" data-tone="' + b.tone + '" x="' + x + '" y="' + y + '" width="' + barW + '" height="' + Math.max(h, 1) + '" rx="3"></rect>' : '') +
        (b.count > 0 ? '<text class="trend-bar-value" x="' + (x + barW / 2) + '" y="' + (y - 5) + '" text-anchor="middle">' + b.count + '</text>' : '') +
        '</g>');
      svgParts.push('<text class="trend-axis-label" x="' + (x + barW / 2) + '" y="' + (padTop + chartH + 16) + '" text-anchor="middle">' + b.start + '-' + b.end + '</text>');
    });

    svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
    svg.setAttribute('width', width);
    svg.setAttribute('height', height);
    svg.innerHTML = svgParts.join('');
    lastHistBuckets = buckets;
  }

  function formatHistTooltip(b) {
    return '<div class="tt-title">' + b.label + '</div>' + b.count + ' kasus menunggu respon';
  }

  // ---------- secondary panels ----------
  function renderBarBreakdown(containerId, items, totalOverride) {
    var container = document.getElementById(containerId);
    var total = totalOverride || items.reduce(function (s, it) { return s + it.value; }, 0) || 1;
    container.innerHTML = items.map(function (it) {
      var pct = Math.round((it.value / total) * 100);
      return (
        '<div class="bar-row">' +
          '<div class="bar-row-top"><span class="bar-row-label">' + escapeHtml(it.label) + '</span><span class="bar-row-value num">' + it.value + '</span></div>' +
          '<div class="bar-track"><div class="bar-fill" style="width:' + pct + '%;background:' + it.color + '"></div></div>' +
        '</div>'
      );
    }).join('');
  }

  function renderSecondary() {
    var records = state.records;

    // Perubahan desil
    var naik = records.filter(function (r) { return r.hasilPemutakhiran === 'Naik'; }).length;
    var sama = records.filter(function (r) { return r.hasilPemutakhiran === 'Sama'; }).length;
    var turun = records.filter(function (r) { return r.hasilPemutakhiran === 'Turun'; }).length;
    renderBarBreakdown('desilBreakdown', [
      { label: 'Sama', value: sama, color: 'var(--neutral-soft)' },
      { label: 'Naik', value: naik, color: 'var(--ink)' },
      { label: 'Turun', value: turun, color: 'var(--ink)' }
    ], records.length);

    // Alasan perbaikan teratas
    var perluRecords = records.filter(function (r) { return r.statusVerifikasi === 'PERLU DIPERBAIKI'; });
    var withNote = perluRecords.filter(function (r) { return r.catatanPerbaikan; });
    var reasonCounts = {};
    withNote.forEach(function (r) {
      var cat = categorizeReason(r.catatanPerbaikan);
      reasonCounts[cat] = (reasonCounts[cat] || 0) + 1;
    });
    var reasonItems = Object.keys(reasonCounts).map(function (k) { return { label: k, value: reasonCounts[k], color: 'var(--neutral)' }; })
      .sort(function (a, b) { return b.value - a.value; });
    renderBarBreakdown('reasonBreakdown', reasonItems, withNote.length);
    var noteFooter = (perluRecords.length - withNote.length) + ' dari ' + perluRecords.length + ' kasus "Perlu Diperbaiki" belum punya catatan rinci.';
    document.getElementById('reasonBreakdown').innerHTML += '<p class="bar-footnote">' + noteFooter + '</p>';

    // Keterjangkauan WA (di antara kasus yang perlu tindak lanjut)
    var followUp = records.filter(function (r) { return r.tindakLanjut; });
    var reach = followUp.filter(function (r) { return r._terjangkauWA; }).length;
    var noWaReg = followUp.filter(function (r) { return r.nomorHp && r.tidakTerdaftarWA; }).length;
    var noPhone = followUp.filter(function (r) { return !r.nomorHp; }).length;
    renderBarBreakdown('waBreakdown', [
      { label: 'Terjangkau WA', value: reach, color: 'var(--ink)' },
      { label: 'Tidak terdaftar WA', value: noWaReg, color: 'var(--accent)' },
      { label: 'Tidak ada nomor HP', value: noPhone, color: 'var(--accent)' }
    ], followUp.length);
  }

  function categorizeReason(note) {
    var n = note.toLowerCase();
    if (n.indexOf('legalisasi') !== -1) return 'Surat legalisasi desa';
    if (n.indexOf('foto') !== -1 || n.indexOf('atap') !== -1 || n.indexOf('dinding') !== -1 || n.indexOf('lantai') !== -1) return 'Foto rumah tidak sesuai';
    if (n.indexOf('format') !== -1) return 'Format surat tidak sesuai';
    return 'Lainnya';
  }

  // ---------- sorting ----------
  var STATUS_RANK = { 'PERLU DIPERBAIKI': 0, 'SESUAI': 1 };
  var TINDAK_RANK = { 'SIAP DICEK ULANG': 0, 'MENUNGGU RESPON': 1, 'SEDANG DIPERBAIKI': 2, '': 3 };

  var SORT_ACCESSORS = {
    noKK: function (r) { return r.noKK || null; },
    nama: function (r) { return r.nama ? r.nama.toLowerCase() : null; },
    tglSubmit: function (r) { return r.tglSubmit || null; },
    statusVerifikasi: function (r) { return r.statusVerifikasi in STATUS_RANK ? STATUS_RANK[r.statusVerifikasi] : null; },
    tglVerifikasi: function (r) { return r.tglVerifikasi || null; },
    tindakLanjut: function (r) { return TINDAK_RANK[r.tindakLanjut] != null ? TINDAK_RANK[r.tindakLanjut] : null; },
    prioritas: function (r) { return r._hariMenunggu; }
  };

  function compareBy(key, dir) {
    var accessor = SORT_ACCESSORS[key] || SORT_ACCESSORS.tglVerifikasi;
    var mul = dir === 'asc' ? 1 : -1;
    return function (a, b) {
      var va = accessor(a), vb = accessor(b);
      var aNull = (va === null || va === undefined);
      var bNull = (vb === null || vb === undefined);
      if (aNull && bNull) return 0;
      if (aNull) return 1;
      if (bNull) return -1;
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * mul;
      return String(va).localeCompare(String(vb), 'id') * mul;
    };
  }

  function syncSortUI() {
    var head = document.getElementById('recordHead');
    Array.prototype.forEach.call(head.querySelectorAll('.cell-sort'), function (btn) {
      if (btn.getAttribute('data-sort-key') === state.sort.key) {
        btn.setAttribute('data-sort-dir', state.sort.dir);
      } else {
        btn.removeAttribute('data-sort-dir');
      }
    });
    var sel = document.getElementById('sortSelect');
    if (sel) sel.value = state.sort.key + ':' + state.sort.dir;
  }

  // ---------- full table ----------
  function getFilteredRecords() {
    var search = state.search.trim().toLowerCase();
    return state.records.filter(function (r) {
      if (state.statusFilter !== 'all' && r.statusVerifikasi !== state.statusFilter) return false;
      if (state.tindakFilter !== 'all') {
        if (state.tindakFilter === 'SELESAI') { if (r.tindakLanjut) return false; }
        else if (r.tindakLanjut !== state.tindakFilter) return false;
      }
      if (search) {
        var hay = (r.nama + ' ' + r.noKK).toLowerCase();
        if (hay.indexOf(search) === -1) return false;
      }
      return true;
    }).sort(compareBy(state.sort.key, state.sort.dir));
  }

  function statusToneAndLabel(r) {
    if (r.statusVerifikasi === 'SESUAI') return { tone: 'muted', label: 'Sesuai' };
    if (r.statusVerifikasi === 'PERLU DIPERBAIKI') return { tone: 'alert', label: 'Perlu Diperbaiki' };
    return { tone: 'muted', label: '–' };
  }
  function tindakToneAndLabel(r) {
    if (r.tindakLanjut === 'SIAP DICEK ULANG') return { tone: 'ink', label: 'Siap Dicek Ulang' };
    if (r.tindakLanjut === 'MENUNGGU RESPON') return { tone: 'alert', label: 'Menunggu Respon' };
    if (r.tindakLanjut === 'SEDANG DIPERBAIKI') return { tone: 'muted', label: 'Sedang Diperbaiki' };
    return { tone: 'plain', label: 'Selesai' };
  }

  function getPageWindow(page, total) {
    var delta = 1;
    var range = [];
    for (var i = 1; i <= total; i++) {
      if (i === 1 || i === total || (i >= page - delta && i <= page + delta)) range.push(i);
    }
    var withDots = [];
    var prev = null;
    range.forEach(function (p) {
      if (prev !== null && p - prev > 1) withDots.push('…');
      withDots.push(p);
      prev = p;
    });
    return withDots;
  }

  function renderPagination(page, totalPages) {
    var el = document.getElementById('tablePagination');
    if (totalPages <= 1) { el.innerHTML = ''; return; }
    var html = '';
    html += '<button type="button" class="page-btn" data-page="' + (page - 1) + '"' + (page <= 1 ? ' disabled' : '') + ' aria-label="Halaman sebelumnya">‹</button>';
    getPageWindow(page, totalPages).forEach(function (p) {
      if (p === '…') html += '<span class="page-ellipsis">…</span>';
      else html += '<button type="button" class="page-btn' + (p === page ? ' is-active' : '') + '" data-page="' + p + '">' + p + '</button>';
    });
    html += '<button type="button" class="page-btn" data-page="' + (page + 1) + '"' + (page >= totalPages ? ' disabled' : '') + ' aria-label="Halaman berikutnya">›</button>';
    el.innerHTML = html;
  }

  function renderTable() {
    var all = getFilteredRecords();
    var totalPages = Math.max(1, Math.ceil(all.length / CONFIG.pageSize));
    if (state.page > totalPages) state.page = totalPages;
    if (state.page < 1) state.page = 1;
    var startIdx = (state.page - 1) * CONFIG.pageSize;
    var shown = all.slice(startIdx, startIdx + CONFIG.pageSize);
    var rowsEl = document.getElementById('recordRows');

    document.getElementById('tableCount').textContent = all.length
      ? ('Menampilkan ' + (startIdx + 1) + '–' + (startIdx + shown.length) + ' dari ' + all.length + ' pengajuan')
      : 'Tidak ada data yang cocok dengan filter.';

    if (!all.length) {
      rowsEl.innerHTML = '<div class="empty-state">Tidak ada data yang cocok dengan filter.</div>';
      document.getElementById('tablePagination').innerHTML = '';
      return;
    }

    rowsEl.innerHTML = shown.map(function (r) {
      var st = statusToneAndLabel(r);
      var tk = tindakToneAndLabel(r);
      var prioritasHtml = r._urgency
        ? '<span class="priority-badge" data-tone="' + r._urgency + '">' + URGENCY_LABEL[r._urgency] + '</span><span class="cell-days num">' + r._hariMenunggu + ' hari</span>'
        : '<span class="cell-dash">–</span>';
      return (
        '<div class="record-row">' +
          '<div class="cell cell-nokk" data-label="No KK">' + maskNoKK(r.noKK) + '</div>' +
          '<div class="cell wrap" data-label="Nama">' + escapeHtml(r.nama) + '</div>' +
          '<div class="cell cell-date" data-label="Tgl Submit">' + formatDateID(r._submitKey) + '</div>' +
          '<div class="cell" data-label="Status"><span class="status-pill" data-tone="' + st.tone + '">' + st.label + '</span></div>' +
          '<div class="cell cell-date" data-label="Tgl Verifikasi">' + formatDateID(r._verifKey) + '</div>' +
          '<div class="cell" data-label="Tindak Lanjut"><span class="status-pill" data-tone="' + tk.tone + '">' + tk.label + '</span></div>' +
          '<div class="cell cell-prioritas" data-label="Prioritas">' + prioritasHtml + '</div>' +
        '</div>'
      );
    }).join('');

    renderPagination(state.page, totalPages);
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ---------- render all ----------
  function renderAll() {
    renderSyncIndicator();
    renderKPIs(state.records);
    renderPriority();
    renderTrend();
    renderHistogram();
    renderSecondary();
    renderTable();
    syncSortUI();
  }

  // ---------- events ----------
  function debounce(fn, wait) {
    var t;
    return function () {
      var args = arguments, ctx = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(ctx, args); }, wait);
    };
  }

  function wireEvents() {
    document.getElementById('refreshBtn').addEventListener('click', refresh);

    document.getElementById('urgencyFilter').addEventListener('click', function (e) {
      var btn = e.target.closest('.chip');
      if (!btn) return;
      Array.prototype.forEach.call(document.querySelectorAll('#urgencyFilter .chip'), function (c) { c.classList.remove('is-active'); });
      btn.classList.add('is-active');
      state.urgencyFilter = btn.getAttribute('data-urgency');
      state.priorityShown = 12;
      renderPriority();
    });

    document.getElementById('priorityMoreBtn').addEventListener('click', function () {
      state.priorityShown += 20;
      renderPriority();
    });

    document.getElementById('searchInput').addEventListener('input', debounce(function (e) {
      state.search = e.target.value;
      state.page = 1;
      renderTable();
    }, 200));

    document.getElementById('statusFilter').addEventListener('change', function (e) {
      state.statusFilter = e.target.value;
      state.page = 1;
      renderTable();
    });

    document.getElementById('tindakFilter').addEventListener('change', function (e) {
      state.tindakFilter = e.target.value;
      state.page = 1;
      renderTable();
    });

    document.getElementById('sortSelect').addEventListener('change', function (e) {
      var parts = e.target.value.split(':');
      state.sort.key = parts[0];
      state.sort.dir = parts[1];
      syncSortUI();
      state.page = 1;
      renderTable();
    });

    document.getElementById('recordHead').addEventListener('click', function (e) {
      var btn = e.target.closest('.cell-sort');
      if (!btn) return;
      var key = btn.getAttribute('data-sort-key');
      if (state.sort.key === key) {
        state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        state.sort.key = key;
        state.sort.dir = 'asc';
      }
      syncSortUI();
      state.page = 1;
      renderTable();
    });

    document.getElementById('tablePagination').addEventListener('click', function (e) {
      var btn = e.target.closest('.page-btn');
      if (!btn || btn.disabled) return;
      var p = parseInt(btn.getAttribute('data-page'), 10);
      if (!p || p < 1) return;
      state.page = p;
      renderTable();
      document.getElementById('tableHeading').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    document.getElementById('trendFrom').addEventListener('change', function (e) {
      state.trendFrom = e.target.value || null;
      renderTrend();
    });
    document.getElementById('trendTo').addEventListener('change', function (e) {
      state.trendTo = e.target.value || null;
      renderTrend();
    });
    document.getElementById('trendResetBtn').addEventListener('click', function () {
      state.trendFrom = null;
      state.trendTo = null;
      renderTrend();
    });
    document.getElementById('trendLegend').addEventListener('click', function (e) {
      var btn = e.target.closest('.legend-item');
      if (!btn) return;
      var series = btn.getAttribute('data-series');
      state.trendVisible[series] = !state.trendVisible[series];
      btn.classList.toggle('is-off', !state.trendVisible[series]);
      btn.setAttribute('aria-pressed', String(state.trendVisible[series]));
      renderTrend();
    });

    attachChartHover(document.getElementById('trendChart'), function () { return lastTrendDays; }, formatTrendTooltip);
    attachChartHover(document.getElementById('cumChart'), function () { return lastCumDays; }, formatCumTooltip);
    attachChartHover(document.getElementById('histChart'), function () { return lastHistBuckets; }, formatHistTooltip);
  }

  // ---------- init ----------
  function init() {
    initTooltip();
    wireEvents();
    loadSnapshot()
      .catch(function (err) {
        console.error('Snapshot load failed:', err);
      })
      .then(function () {
        loadLive();
      });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
