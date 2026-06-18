// MyEfrei ULTRA - Chat | AI Content Script
// Runs at document_start — signals presence immediately
(function () {
  'use strict';

  // ── Signal presence to the main extension via DOM attribute ─────────────
  document.documentElement.setAttribute('data-myefrei-chat-enabled', 'true');

  // ── Module-level AI state ────────────────────────────────────────────────
  let aiMessages = [];
  let currentUserId = 0;
  let currentSesskey = '';

  // ── Shared Moodle config helpers ─────────────────────────────────────────
  const extractMoodleConfig = () => {
    console.log('[MyEfrei ULTRA] Starting Moodle config extraction...');
    let sesskey = document.documentElement.getAttribute('data-moodle-sesskey');
    let userid = document.documentElement.getAttribute('data-moodle-userid');

    if (!userid || userid === '0') {
      const body = document.body;
      if (body) {
        const m = (body.className || '').match(/\buser-(\d+)\b/);
        if (m) userid = m[1];
      }
    }
    try {
      if (!sesskey) sesskey = sessionStorage.getItem('moodle_sesskey');
      if (!userid) userid = sessionStorage.getItem('moodle_userid');
    } catch (e) {}

    if (!sesskey || !userid || userid === '0') {
      const scripts = document.getElementsByTagName('script');
      for (let i = 0; i < scripts.length; i++) {
        const content = scripts[i].textContent || '';
        const cfgMatch = content.match(/M\.cfg\s*=\s*(\{[\s\S]*?\})/i);
        if (cfgMatch) {
          try {
            const parsed = JSON.parse(cfgMatch[1]);
            if (parsed.sesskey && !sesskey) sesskey = parsed.sesskey;
            if (parsed.userid && (!userid || userid === '0')) userid = String(parsed.userid);
          } catch (e) {
            const block = cfgMatch[1];
            if (!sesskey) { const m = block.match(/sesskey['\"]?\s*[:=]\s*['\"]([^'"]+)['"]/i); if (m) sesskey = m[1]; }
            if (!userid || userid === '0') { const m = block.match(/userid['\"]?\s*[:=]\s*['"']?(\d+)['"']?/i); if (m) userid = m[1]; }
          }
        }
        if (!sesskey) { const m = content.match(/sesskey['\"]?\s*[:=]\s*['\"]([^'"]+)['"]/i); if (m) sesskey = m[1]; }
        if (!userid || userid === '0') { const m = content.match(/userid['\"]?\s*[:=]\s*['"']?(\d+)['"']?/i); if (m) userid = m[1]; }
      }
    }

    if (sesskey === 'null' || sesskey === 'undefined') sesskey = '';
    if (userid === 'null' || userid === 'undefined') userid = '0';

    console.log(`[MyEfrei ULTRA] Extracted - sesskey: ${sesskey ? 'found' : 'NOT found'}, userid: ${userid && userid !== '0' ? userid : 'NOT found'}`);

    try {
      if (sesskey) { document.documentElement.setAttribute('data-moodle-sesskey', sesskey); sessionStorage.setItem('moodle_sesskey', sesskey); }
      if (userid && userid !== '0') { document.documentElement.setAttribute('data-moodle-userid', userid); sessionStorage.setItem('moodle_userid', userid); }
      
      if (chrome && chrome.storage && chrome.storage.local) {
        const dataToSave = {};
        if (sesskey) dataToSave.moodle_sesskey = sesskey;
        if (userid && userid !== '0') dataToSave.moodle_userid = userid;

        if (Object.keys(dataToSave).length > 0) {
            chrome.storage.local.set(dataToSave, () => {
                console.log('[MyEfrei ULTRA] Session data saved to extension storage:', dataToSave);
            });
        } else {
            console.log('[MyEfrei ULTRA] No session data to save.');
        }
      }

    } catch (e) {
        console.error('[MyEfrei ULTRA] Error saving session data:', e);
    }

    return { sesskey: sesskey || '', userid: userid ? parseInt(userid, 10) : 0 };
  };

  // The rest of the file remains the same...
  const callMoodleAjax = async (methodname, args) => {
    if (!currentSesskey || !currentUserId) {
      const config = extractMoodleConfig();
      if (config.sesskey) currentSesskey = config.sesskey;
      if (config.userid) currentUserId = config.userid;
    }
    if (!currentSesskey) throw new Error('Moodle session key not loaded.');
    const url = `${window.location.origin}/lib/ajax/service.php?sesskey=${currentSesskey}&info=${methodname}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([{ index: 0, methodname, args }])
    });
    if (!response.ok) throw new Error(`Fetch failed: ${response.statusText}`);
    const data = await response.json();
    if (!data || !data[0]) throw new Error('Invalid AJAX response format');
    if (data[0].error) {
      const ex = data[0].exception;
      throw new Error(ex ? (typeof ex === 'object' ? (ex.message || JSON.stringify(ex)) : ex) : 'Moodle AJAX exception');
    }
    return data[0].data;
  };

  const waitForUserId = () => new Promise((resolve, reject) => {
    if (currentUserId && currentUserId !== 0) { resolve(currentUserId); return; }
    let tries = 0;
    const check = () => {
      const cfg = extractMoodleConfig();
      if (cfg.sesskey) currentSesskey = cfg.sesskey;
      if (cfg.userid && cfg.userid !== 0) { currentUserId = cfg.userid; resolve(currentUserId); return; }
      if (currentUserId && currentUserId !== 0) { resolve(currentUserId); return; }
      tries++;
      if (tries > 50) { reject(new Error('Session Moodle non disponible. Reconnecte-toi.')); return; }
      setTimeout(check, 100);
    };
    check();
  });

  const normalizeStr = (s) => {
    if (!s) return '';
    let norm = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    norm = norm.replace(/([a-z])\s+(\d)/g, '$1$2').replace(/(\d)\s+([a-z])/g, '$1$2');
    return norm.replace(/[^a-z0-9\s]/g, ' ').trim();
  };

  const cleanCourseTitle = (fullname) => {
    if (!fullname) return '';
    const cleanRegex = /^\s*\*?\s*([A-Z0-9]+(?:-[A-Z0-9]+)*)\s*(?:-|\u2013|\u2014)\s*/i;
    return fullname.replace(cleanRegex, '').replace(/\s*\([^)]*\)\s*$/g, '').trim() || fullname;
  };

  const levenshtein = (a, b) => {
    const m = a.length, n = b.length;
    const dp = Array.from({length: m + 1}, (_, i) => Array.from({length: n + 1}, (_, j) => i === 0 ? j : j === 0 ? i : 0));
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
      }
    }
    return dp[m][n];
  };

  const fuzzyScore = (query, target) => {
    if (!query || !target) return 0;
    const q = normalizeStr(query);
    const t = normalizeStr(target);
    if (!q || !t) return 0;

    const synonymGroups = [
      ["ce", "controle ecrit"],
      ["de", "dst", "devoir ecrit", "devoir sur table"],
      ["qcm", "question a choix multiple", "questionnaire a choix multiples", "choix multiples"],
      ["cm", "cours magistral"],
      ["td", "travaux diriges", "travail dirige"],
      ["tp", "travaux pratiques", "experience"],
      ["cc", "controle continu"]
    ];

    const hasTerm = (str, term) => {
      let idx = -1;
      while ((idx = str.indexOf(term, idx + 1)) !== -1) {
        const before = idx === 0 || str[idx - 1] === ' ';
        if (before) {
          const nextChar = str[idx + term.length];
          const isEnd = nextChar === undefined;
          const isSpace = nextChar === ' ';
          const isDigit = nextChar >= '0' && nextChar <= '9';
          if (isEnd || isSpace || isDigit) {
            if (term === "de" || term === "ce") {
              if (idx === 0 || isEnd || isDigit) return true;
            } else {
              return true;
            }
          }
        }
      }
      return false;
    };

    for (const group of synonymGroups) {
      let qMatched = null, tMatched = null;
      for (const item of group) {
        if (!qMatched && hasTerm(q, item)) qMatched = item;
        if (!tMatched && hasTerm(t, item)) tMatched = item;
      }
      if (qMatched && tMatched && qMatched !== tMatched) return 0.95;
    }

    const montrealGroup = [
      "montreal", "concordia", "concordia university",
      "quebec", "yul", "hec montreal", "mcgill", "uqam", "vieux montreal",
      "plateau mont royal", "guy concordia", "loyola campus", "sgw campus"
    ];
    const torontoGroup = [
      "toronto", "ilac",
      "ontario", "yyz", "gta", "greater toronto area", "ilac international college",
      "cn tower", "north york", "downtown toronto"
    ];

    const qHasMontreal = montrealGroup.some(item => hasTerm(q, item));
    const tHasMontreal = montrealGroup.some(item => hasTerm(t, item));
    const qHasToronto  = torontoGroup.some(item => hasTerm(q, item));
    const tHasToronto  = torontoGroup.some(item => hasTerm(t, item));
    const hasConflict  = (qHasMontreal && tHasToronto) || (qHasToronto && tHasMontreal);

    if (!hasConflict) {
      const canadaGroup = ["canada", ...montrealGroup, ...torontoGroup];
      if (canadaGroup.some(i => hasTerm(q, i)) && canadaGroup.some(i => hasTerm(t, i))) return 0.95;
    }

    const destinationGroups = [
      ["etats unis","usa","us","united states","irvine","uci","california","californie","university of california irvine","orange county","oc","socal","southern california","los angeles","la","lax","anteaters"],
      ["hongrie","budapest","essca","hungary","bud","danube","bme","corvinus","essca school of management","pest","buda","europe centrale"],
      ["pologne","varsovie","warsaw","agh","agh university","poland","waw","cracovie","krakow","malopolska","mazovie","vistule","agh university of science and technology"],
      ["republique tcheque","tchequie","tcheque","ostrava","vsb","tuo","vsb tuo","czech","czech republic","czechia","boheme","moravie","silesie","prague","prg","moravian silesian","poruba"],
      ["malaisie","kuala lumpur","kuala lampur","apu","asia pacific university","malaysia","kl","kul","klcc","selangor","bukit jalil","petronas","asie du sud est"],
      ["afrique du sud","south africa","cput","cape peninsula","za","cpt","cape town","le cap","western cape","peninsule du cap","bellville","district six"],
      ["inde","india","mahe","manipal","bom","del","karnataka","manipal academy of higher education","udupi","bangalore","bengaluru"],
      ["chine","china","seu","southeast university","nanjing","nankin","jiangsu","pkin","shanghai","pvg","nkg"],
      ["angleterre","uk","royaume uni","united kingdom","staffordshire","england","gb","great britain","stoke on trent","midlands","west midlands","lhr","london"]
    ];

    for (const group of destinationGroups) {
      if (group.some(i => hasTerm(q, i)) && group.some(i => hasTerm(t, i))) return 0.95;
    }

    if (t === q) return 1;
    const isShort = q.length <= 3;
    const matchesSafeSubstring = isShort ? t.split(/\s+/).some(w => w.startsWith(q)) : t.includes(q);
    if (matchesSafeSubstring) return 0.95;

    const qStripped = q.replace(/\s+/g, '');
    const tStripped = t.replace(/\s+/g, '');
    if (qStripped && tStripped && qStripped === tStripped) return 0.90;

    const stopWords = new Set(['quand','est','ce','que','je','j','aurais','ai','un','une','des','le','la','les','du','de','en','pour','mes','mon','ma','ta','tes','son','ses','nous','vous','ils','elles','sont','ont','y','a','t','il','elle','dans','avec','par','sur','pour','qui','quoi','dont','ou','comment','pourquoi','quel','quels','quelle','quelles','c','d','l','s','m','t','n']);
    const qWordsRaw = q.split(/\s+/).filter(Boolean);
    const qWordsFiltered = qWordsRaw.filter(w => !stopWords.has(w));
    const qWords = qWordsFiltered.length > 0 ? qWordsFiltered : qWordsRaw;
    const tWords = t.split(/\s+/).filter(Boolean);
    let wordHits = 0;
    for (const qw of qWords) {
      for (const tw of tWords) {
        const maxLen = Math.max(qw.length, tw.length);
        if (maxLen === 0) continue;
        const dist = levenshtein(qw, tw);
        const threshold = qw.length <= 3 ? 0 : qw.length <= 5 ? 1 : qw.length <= 8 ? 2 : 3;
        const isPrefixMatch = qw.length >= 2 && tw.length >= 2 && (tw.startsWith(qw) || (tw.length >= 3 && qw.startsWith(tw)));
        const isSubstrMatch = qw.length >= 4 && tw.length >= 4 && (tw.includes(qw) || qw.includes(tw));
        if (dist <= threshold || isPrefixMatch || isSubstrMatch) { wordHits++; break; }
      }
    }
    if (wordHits === qWords.length) return 0.8;
    if (wordHits > 0) return 0.4 + (wordHits / qWords.length) * 0.3;
    const dist = levenshtein(q, t.substring(0, Math.min(t.length, q.length + 10)));
    const norm = dist / Math.max(q.length, 1);
    return norm <= 0.4 ? Math.max(0, 0.4 - norm) : 0;
  };

  const MATCH_THRESHOLD = 0.5;

  const getMyCourses = async () => {
    try {
      const cached = sessionStorage.getItem('mymoodle_courses_cache');
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed && parsed.length > 0) return parsed;
      }
    } catch (e) {}
    const uid = await waitForUserId();
    let recentCourses = [];
    try {
      const data = await callMoodleAjax('core_course_get_recent_courses', { userid: uid });
      if (data && Array.isArray(data)) recentCourses = data;
    } catch (e) { console.warn('[IA Search] Fetching recent courses failed:', e.message); }
    if (recentCourses.length > 0) {
      try { sessionStorage.setItem('mymoodle_courses_cache', JSON.stringify(recentCourses)); } catch (e) {}
    }
    return recentCourses;
  };

  const searchMoodleContent = async (query) => {
    try {
      const data = await callMoodleAjax('core_search_get_results', { query, filters: {}, page: 0 });
      return (data && data.results) ? data.results : [];
    } catch { return []; }
  };

  const searchUsers = async (query) => {
    const uid = await waitForUserId();
    try {
      const data = await callMoodleAjax('core_user_search_identity', { query, capabilities: [] });
      return (data && data.list) ? data.list : [];
    } catch {
      try {
        const data2 = await callMoodleAjax('core_message_search_users', { userid: uid, search: query, limitfrom: 0, limitnum: 10 });
        return [...(data2.contacts || []), ...(data2.noncontacts || [])];
      } catch { return []; }
    }
  };

  const getCalendarEvents = async () => {
    try {
      const now = Math.floor(Date.now() / 1000);
      const data = await callMoodleAjax('core_calendar_get_action_events_by_timesort', {
        timesortfrom: now - (30 * 24 * 60 * 60),
        timesortto: now + (150 * 24 * 60 * 60),
        limitnum: 50, aftereventid: 0
      });
      return (data && data.events) ? data.events : [];
    } catch (e) {
      console.warn('[IA Search] getCalendarEvents failed:', e);
      return [];
    }
  };

  const getCourseContents = async (courseId) => {
    const cacheKey = `mymoodle_course_contents_${courseId}`;
    try {
      const cached = sessionStorage.getItem(cacheKey);
      if (cached) { const p = JSON.parse(cached); if (p && Array.isArray(p)) return p; }
    } catch (e) {}
    try {
      const data = await callMoodleAjax('core_courseformat_get_state', { courseid: courseId });
      if (data) {
        let state = typeof data === 'string' ? JSON.parse(data) : data;
        if (state && Array.isArray(state.section) && Array.isArray(state.cm)) {
          const mappedSections = state.section.map(sec => {
            const secModules = state.cm
              .filter(cm => String(cm.sectionid) === String(sec.id) || String(cm.sectionnumber) === String(sec.number))
              .map(cm => {
                const mod = { id: cm.id, name: cm.name, modname: cm.module || '', url: cm.url || '', contents: [] };
                if (cm.module === 'resource') mod.contents.push({ type: 'file', filename: cm.name, fileurl: cm.url });
                return mod;
              });
            return { name: sec.title || sec.rawtitle || '', section: sec.number, modules: secModules };
          });
          try { sessionStorage.setItem(cacheKey, JSON.stringify(mappedSections)); } catch (e) {}
          return mappedSections;
        }
      }
      return [];
    } catch (err) {
      console.warn(`[IA Search] core_courseformat_get_state failed for course ${courseId}:`, err);
      return [];
    }
  };

  const deepSearchMoodle = async (query) => {
    const results = [];
    const origin = window.location.origin;
    let allCourses = await getMyCourses();
    const normQuery = normalizeStr(query);

    let isFilesIntent = false, isDevoirsIntent = false, isQuizIntent = false;
    let isCalendarIntent = false, isScopedSearch = false;
    let cleanQuery = query, targetCourseQuery = '', targetCourse = null;

    const calendarKeywords = ['deadlines','deadline','calendrier','agenda','planning','todo','a faire','echeances','echeance'];
    const hasCalendarKeyword = calendarKeywords.some(kw => {
      const idx = normQuery.indexOf(kw);
      if (idx === -1) return false;
      const before = idx === 0 || normQuery[idx - 1] === ' ';
      const after = (idx + kw.length) === normQuery.length || [' ','?','!'].includes(normQuery[idx + kw.length]);
      return before && after;
    });

    if (normQuery === 'mes devoirs' || normQuery === 'devoirs' || normQuery === 'devoir') isDevoirsIntent = true;
    else if (normQuery === 'mes quiz' || normQuery === 'quiz' || normQuery === 'qcm') isQuizIntent = true;
    else if (hasCalendarKeyword) isCalendarIntent = true;
    else {
      const match = query.match(/(.+)\s+(dans|de|en)\s+(.+)/i);
      if (match) {
        const potentialResource = match[1].trim();
        const potentialCourse = match[3].trim();
        let bestScore = 0;
        for (const c of allCourses) {
          const score = Math.max(fuzzyScore(potentialCourse, c.fullname || ''), fuzzyScore(potentialCourse, c.shortname || ''));
          if (score > bestScore && score >= MATCH_THRESHOLD) { bestScore = score; targetCourse = c; }
        }
        if (targetCourse) {
          isScopedSearch = true;
          targetCourseQuery = potentialCourse;
          const resLower = potentialResource.toLowerCase().trim();
          if (['fichiers','fichier','files','file','cours'].includes(resLower)) { isFilesIntent = true; cleanQuery = ''; }
          else {
            cleanQuery = potentialResource;
            if (['devoirs','devoir','assignments','assignment','rendre'].includes(resLower)) isDevoirsIntent = true;
            else if (['quiz','tests','test','qcm'].includes(resLower)) isQuizIntent = true;
            else if (calendarKeywords.includes(resLower)) isCalendarIntent = true;
          }
        }
      }
      if (!targetCourse) {
        if (normQuery.startsWith('fichiers dans ') || normQuery.startsWith('fichier dans ') || normQuery.startsWith('fichiers de ') || normQuery.startsWith('fichier de ')) {
          isFilesIntent = true;
          targetCourseQuery = query.replace(/^(fichiers? (dans|de) )/i, '').trim();
          let bestScore = 0;
          for (const c of allCourses) {
            const score = Math.max(fuzzyScore(targetCourseQuery, c.fullname || ''), fuzzyScore(targetCourseQuery, c.shortname || ''));
            if (score > bestScore && score >= MATCH_THRESHOLD) { bestScore = score; targetCourse = c; }
          }
          cleanQuery = '';
        }
      }
    }

    const coursesWithIndex = allCourses.map((c, index) => ({ c, index }));
    coursesWithIndex.sort((a, b) => {
      if (targetCourse) { if (a.c.id === targetCourse.id) return -1; if (b.c.id === targetCourse.id) return 1; }
      const sA = Math.max(fuzzyScore(query, a.c.fullname || ''), fuzzyScore(query, a.c.shortname || ''));
      const sB = Math.max(fuzzyScore(query, b.c.fullname || ''), fuzzyScore(query, b.c.shortname || ''));
      if (sA !== sB) return sB - sA;
      return a.index - b.index;
    });
    allCourses = coursesWithIndex.map(item => item.c);

    const courseHits = [];
    if (isScopedSearch && targetCourse) {
      courseHits.push({ ...targetCourse, _score: 0.6 });
    } else {
      for (const c of allCourses) {
        const score = Math.max(fuzzyScore(query, c.fullname || ''), fuzzyScore(query, c.shortname || ''));
        if (score >= MATCH_THRESHOLD) courseHits.push({ ...c, _score: score });
      }
      courseHits.sort((a, b) => b._score - a._score);
    }
    for (const c of courseHits.slice(0, 5)) {
      results.push({ type: 'course', icon: '📚', title: cleanCourseTitle(c.fullname), subtitle: c.shortname || c.fullname, url: `${origin}/course/view.php?id=${c.id}`, score: c._score });
    }

    try {
      const calendarEvents = await getCalendarEvents();
      let calendarFilterQuery = '';
      if (isCalendarIntent) {
        const sw = new Set(['les','la','le','un','une','des','du','de','en','pour','mes','mon','ma','prochains','prochaine','prochaines','quand','c','est','deadlines','deadline','calendrier','agenda','planning','todo','a faire','echeances','echeance']);
        calendarFilterQuery = normQuery.split(/\s+/).filter(w => !sw.has(w)).join(' ');
      }
      for (const ev of calendarEvents) {
        const evName = ev.name || '';
        const courseName = (ev.course && ev.course.fullname) || '';
        if (isScopedSearch && targetCourse && (!ev.course || ev.course.id !== targetCourse.id)) continue;
        const eventTime = ev.timesort || 0;
        const now = Math.floor(Date.now() / 1000);
        if (eventTime < now) {
          const askPast = ['passe','passes','historique','anciens','archive','depasse','depasses','retard','en retard'].some(kw => normQuery.includes(kw));
          if (!askPast) continue;
        }
        const searchQ = isScopedSearch ? cleanQuery : query;
        let score = 0;
        if (isCalendarIntent && calendarFilterQuery) {
          score = Math.max(fuzzyScore(calendarFilterQuery, evName), fuzzyScore(calendarFilterQuery, evName + ' ' + courseName));
        } else if (searchQ) {
          score = Math.max(fuzzyScore(searchQ, evName), fuzzyScore(searchQ, evName + ' ' + courseName));
        } else {
          score = 0.5;
        }
        const isAssignEvent = ev.eventtype === 'due' || ev.modulename === 'assign' || evName.toLowerCase().includes('devoir') || evName.toLowerCase().includes('rendre');
        const isQuizEvent = ev.modulename === 'quiz' || evName.toLowerCase().includes('quiz') || evName.toLowerCase().includes('test');
        if (isCalendarIntent) { score = (calendarFilterQuery ? (score >= MATCH_THRESHOLD ? 0.98 : 0) : 0.98); }
        else if (isDevoirsIntent && isAssignEvent) { score = 0.98; }
        else if (isQuizIntent && isQuizEvent) { score = 0.98; }
        if (score >= MATCH_THRESHOLD || (isDevoirsIntent && isAssignEvent) || (isQuizIntent && isQuizEvent) || (isCalendarIntent && !calendarFilterQuery)) {
          const dateObj = new Date(ev.timesort * 1000);
          const dateStr = dateObj.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
          results.push({
            type: 'deadline', icon: '📅', title: evName,
            subtitle: `${cleanCourseTitle(courseName)} • À rendre : ${dateStr}`,
            url: ev.url || ev.viewurl || `${origin}/calendar/view.php?view=day&time=${ev.timesort}`,
            score: isScopedSearch ? 0.90 + (score * 0.09) : Math.max(score, 0.4) + 0.15
          });
        }
      }
    } catch (e) { console.warn('[IA Search] calendar search failed:', e.message); }

    try {
      const searchQ = isScopedSearch ? cleanQuery : query;
      if (searchQ) {
        const nativeResults = await searchMoodleContent(searchQ);
        for (const nr of nativeResults) {
          if (isScopedSearch && targetCourse) {
            const matchesCourse = (nr.coursename && (fuzzyScore(targetCourseQuery, nr.coursename) >= MATCH_THRESHOLD)) || (nr.contextname && (fuzzyScore(targetCourseQuery, nr.contextname) >= MATCH_THRESHOLD));
            if (!matchesCourse) continue;
          }
          const score = fuzzyScore(searchQ, nr.title || '');
          const isFile = nr.url && (nr.url.includes('/resource/') || nr.url.includes('/file.php') || nr.url.includes('mod_resource'));
          const ext = isFile ? ((nr.title && nr.title.split('.').pop()) || 'pdf').toLowerCase() : '';
          results.push({
            type: isFile ? 'file' : 'activity', icon: isFile ? '📄' : '📌',
            title: nr.title, subtitle: cleanCourseTitle(nr.coursename || nr.contextname || ''),
            url: nr.url, score: isScopedSearch ? 0.90 + (score * 0.09) : (score >= MATCH_THRESHOLD ? score + 0.1 : 0.45), ext
          });
        }
      }
    } catch (e) { console.warn('[IA Search] native content search failed:', e.message); }

    const coursesToScan = (isScopedSearch && targetCourse) ? [targetCourse] : allCourses.slice(0, 25);
    const contentPromises = coursesToScan.map(c => getCourseContents(c.id).then(sections => ({ course: c, sections })));
    const courseContents = await Promise.allSettled(contentPromises);

    const moduleTypeIcon = (mod) => {
      const t = (mod.modname || '').toLowerCase();
      if (t === 'resource' || t === 'url') return '📄';
      if (t === 'folder') return '📁';
      if (t === 'assign') return '📝';
      if (t === 'quiz') return '❓';
      if (t === 'forum') return '💬';
      if (t === 'page') return '🌐';
      if (t === 'scorm' || t === 'h5pactivity') return '🎮';
      if (t === 'video' || t === 'videofile') return '🎥';
      if (t === 'glossary') return '📖';
      if (t === 'wiki') return '📝';
      if (t === 'choice') return '🗳️';
      if (t === 'survey') return '📊';
      if (t === 'lesson') return '🎓';
      return '📌';
    };

    for (const pr of courseContents) {
      if (pr.status !== 'fulfilled') continue;
      const { course, sections } = pr.value;
      for (const section of (sections || [])) {
        const secName = section.name || '';
        let secScore = 0;
        const searchQ = isScopedSearch ? cleanQuery : query;
        if (searchQ) {
          secScore = Math.max(fuzzyScore(searchQ, secName), fuzzyScore(searchQ, `${course.fullname} ${secName}`) * 0.8);
        } else { secScore = 0.5; }
        if ((secScore >= MATCH_THRESHOLD || isScopedSearch) && secName) {
          results.push({ type: 'section', icon: '📂', title: secName, subtitle: `Section dans : ${cleanCourseTitle(course.fullname)}`, url: `${origin}/course/view.php?id=${course.id}#section-${section.section}`, score: isScopedSearch ? 0.90 + (secScore * 0.09) : secScore });
        }
        if (!section.modules) continue;
        for (const mod of section.modules) {
          const modName = mod.name || '';
          let modScore = 0;
          if (searchQ) {
            modScore = Math.max(fuzzyScore(searchQ, modName), fuzzyScore(searchQ, `${course.fullname} ${modName}`) * 0.85, fuzzyScore(searchQ, mod.modname || ''), fuzzyScore(searchQ, secName));
          } else { modScore = 0.5; }
          if (isDevoirsIntent && mod.modname === 'assign') modScore = 0.98;
          else if (isQuizIntent && mod.modname === 'quiz') modScore = 0.98;
          if (modScore >= MATCH_THRESHOLD || (isDevoirsIntent && mod.modname === 'assign') || (isQuizIntent && mod.modname === 'quiz')) {
            results.push({ type: mod.modname || 'module', icon: moduleTypeIcon(mod), title: modName, subtitle: `${cleanCourseTitle(course.fullname)}${secName ? ' › ' + secName : ''}`, url: mod.url || `${origin}/course/view.php?id=${course.id}`, score: isScopedSearch ? 0.90 + (modScore * 0.09) : modScore });
          }
          if (!mod.contents || !Array.isArray(mod.contents)) continue;
          for (const file of mod.contents) {
            if (file.type !== 'file') continue;
            const fname = file.filename || '';
            if (!fname || fname === 'index.htm' || fname === 'index.html') continue;
            let fileScore = 0;
            if (searchQ) {
              fileScore = Math.max(
                fuzzyScore(searchQ, fname),
                fuzzyScore(searchQ, fname.replace(/\.[^.]+$/, '')),
                fuzzyScore(searchQ, `${course.fullname} ${modName} ${fname}`) * 0.85,
                fuzzyScore(searchQ, modName) * 0.7,
                fuzzyScore(searchQ, secName) * 0.5
              );
            } else { fileScore = 0.5; }
            const isTargetCourseFile = targetCourse && course.id === targetCourse.id;
            if (isTargetCourseFile && (isFilesIntent || fileScore >= MATCH_THRESHOLD)) fileScore = 0.98;
            if (fileScore >= MATCH_THRESHOLD || (isFilesIntent && isTargetCourseFile)) {
              const ext = (fname.split('.').pop() || '').toLowerCase();
              const fileIcon = ext === 'pdf' ? '📕' : ['doc','docx'].includes(ext) ? '📘' : ['xls','xlsx'].includes(ext) ? '📗' : ['ppt','pptx'].includes(ext) ? '📙' : ['zip','rar','7z'].includes(ext) ? '🗜️' : ['mp4','avi','mkv','mov'].includes(ext) ? '🎥' : ['mp3','wav','ogg'].includes(ext) ? '🎵' : ['jpg','jpeg','png','gif','svg'].includes(ext) ? '🖼️' : ['py','js','java','c','cpp','html','css'].includes(ext) ? '💻' : '📄';
              results.push({ type: 'file', icon: fileIcon, title: fname, subtitle: `${cleanCourseTitle(course.fullname)} › ${modName}${secName ? ' › ' + secName : ''}`, url: file.fileurl || mod.url || `${origin}/course/view.php?id=${course.id}`, score: isScopedSearch ? 0.90 + (fileScore * 0.09) : fileScore, ext });
            }
          }
        }
      }
    }

    if (!isScopedSearch) {
      try {
        const userHits = await searchUsers(query);
        for (const u of userHits.slice(0, 3)) {
          const fullname = u.fullname || ((u.firstname || '') + ' ' + (u.lastname || '')).trim();
          if (!fullname) continue;
          results.push({ type: 'user', icon: '👤', title: fullname, subtitle: u.email || '', url: `${origin}/user/profile.php?id=${u.id}`, score: fuzzyScore(query, fullname) + 0.1 });
        }
      } catch (e) { console.warn('[IA Search] user search failed:', e.message); }
    }

    const seen = new Set();
    return results
      .filter(r => { if (seen.has(r.url)) return false; seen.add(r.url); return true; })
      .filter(r => r.score >= 0.5)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
  };

  const iaRenderResults = (results, query) => {
    if (results.length === 0) return `<div class="ia-no-results">😕 Je n'ai rien trouvé, déso.</div>`;
    const typeLabel = { course: 'Cours', section: 'Section', resource: 'Ressource', assign: 'Devoir', quiz: 'Quiz', forum: 'Forum', page: 'Page', folder: 'Dossier', url: 'Lien', user: 'Utilisateur', module: 'Activité', file: 'Fichier', deadline: 'Date limite' };
    const fileCount = results.filter(r => r.type === 'file').length;
    const deadlineCount = results.filter(r => r.type === 'deadline').length;
    const otherCount = results.length - fileCount - deadlineCount;
    const summaryParts = [];
    if (otherCount > 0) summaryParts.push(`${otherCount} activité${otherCount > 1 ? 's' : ''}`);
    if (fileCount > 0) summaryParts.push(`${fileCount} fichier${fileCount > 1 ? 's' : ''}`);
    if (deadlineCount > 0) summaryParts.push(`${deadlineCount} date${deadlineCount > 1 ? 's' : ''} limite`);
    let html = `<div class="ia-results-header">${results.length} résultat${results.length > 1 ? 's' : ''} pour <strong>"${query}"</strong>${summaryParts.length ? ' <span class="ia-results-breakdown">(' + summaryParts.join(', ') + ')</span>' : ''}</div><div class="ia-results-list">`;
    for (const r of results) {
      const isFile = r.type === 'file';
      const isDeadline = r.type === 'deadline';
      const label = isFile && r.ext ? r.ext.toUpperCase() : (typeLabel[r.type] || r.type);
      const pct = Math.round(Math.min(r.score, 1) * 100);
      html += `<a href="${r.url}" target="_blank" class="ia-result-card${isFile ? ' ia-result-file' : ''}${isDeadline ? ' ia-result-deadline' : ''}">
        <div class="ia-result-icon">${r.icon}</div>
        <div class="ia-result-body">
          <div class="ia-result-title">${r.title}</div>
          ${r.subtitle ? `<div class="ia-result-subtitle">${r.subtitle}</div>` : ''}
          <div class="ia-result-meta"><span class="ia-result-type${isFile ? ' ia-file-badge' : ''}${isDeadline ? ' ia-deadline-badge' : ''}">${label}</span><span class="ia-result-score">${pct}% pertinence</span></div>
        </div>
        <div class="ia-result-arrow"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="display:block;"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg></div>
      </a>`;
    }
    html += '</div>';
    return html;
  };

  const getAdaptedSuggestions = (results, query) => {
    const destinations = [
      { name: "États-Unis", keywords: ["etats unis","usa","us","united states","irvine","uci","california","californie","los angeles","lax","anteaters"] },
      { name: "Montréal", keywords: ["montreal","concordia","yul","hec montreal","hec","mcgill","uqam","vieux montreal","plateau mont royal","guy concordia","loyola campus","sgw campus"] },
      { name: "Toronto", keywords: ["toronto","ilac","yyz","gta","greater toronto area","cn tower","north york","downtown toronto"] },
      { name: "Canada", keywords: ["canada","quebec","ontario"] },
      { name: "Budapest", keywords: ["hongrie","budapest","essca","hungary","bud","danube","bme","corvinus","pest","buda","europe centrale"] },
      { name: "Varsovie", keywords: ["pologne","varsovie","warsaw","agh","poland","waw","cracovie","krakow","malopolska","mazovie","vistule"] },
      { name: "Ostrava", keywords: ["republique tcheque","tchequie","tcheque","ostrava","vsb","tuo","vsb tuo","czech","czech republic","czechia","boheme","moravie","silesie","prague","prg","moravian silesian","poruba"] },
      { name: "Kuala Lumpur", keywords: ["malaisie","kuala lumpur","apu","malaysia","kl","kul","klcc","selangor","bukit jalil","petronas"] },
      { name: "Afrique du Sud", keywords: ["afrique du sud","south africa","cput","cape town","le cap","cpt","western cape","peninsule du cap","bellville","district six"] },
      { name: "Inde", keywords: ["inde","india","mahe","manipal","bom","del","karnataka","udupi","bangalore","bengaluru"] },
      { name: "Chine", keywords: ["chine","china","seu","nanjing","nankin","jiangsu","pkin","shanghai","pvg","nkg"] },
      { name: "Angleterre", keywords: ["angleterre","uk","royaume uni","united kingdom","staffordshire","england","gb","great britain","stoke on trent","london"] }
    ];

    const matchDestination = (textStr) => {
      if (!textStr) return null;
      const normText = normalizeStr(textStr);
      for (const dest of destinations) {
        for (const kw of dest.keywords) {
          const escaped = normalizeStr(kw).replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
          if (new RegExp('\\b' + escaped + '\\b', 'i').test(normText)) return dest;
        }
      }
      return null;
    };

    let matchedDest = matchDestination(query);
    if (!matchedDest && results && results.length > 0) {
      for (const r of results) {
        matchedDest = matchDestination(r.title) || matchDestination(r.subtitle);
        if (matchedDest) break;
      }
    }
    if (matchedDest) return [`Deadlines ${matchedDest.name}`, `Fichiers ${matchedDest.name}`, `Mes devoirs`];

    const firstCourse = results.find(r => r.type === 'course');
    if (firstCourse) {
      const cleanTitle = cleanCourseTitle(firstCourse.title);
      const displayTitle = cleanTitle.length > 20 ? cleanTitle.substring(0, 20).trim() + '...' : cleanTitle;
      return [`Fichiers ${displayTitle}`, `Devoirs ${displayTitle}`, `Mes deadlines`];
    }

    return results && results.length > 0 ? ['Chercher un cours', 'Mes devoirs', 'Mes deadlines'] : ['Essayer une autre orthographe', 'Mes devoirs', 'Mes deadlines'];
  };

  const getAiMessages = () => {
    if (aiMessages.length === 0) {
      aiMessages.push({
        useridfrom: 0,
        text: `<div class="ia-welcome"><div class="ia-welcome-icon">🔍</div><strong>Recherche Moodle intelligente</strong><p>Je peux trouver n'importe quel contenu : cours, fichiers, devoirs, quiz, deadlines, calendriers, utilisateurs… même avec des fautes de frappe !</p><p class="ia-welcome-hint">Essaie par exemple : <em>"deadlines"</em>, <em>"devoir en eco"</em>, <em>"algo"</em></p></div>`,
        timecreated: Date.now() / 1000
      });
    }
    return aiMessages;
  };

  const renderAiChat = () => {
    const history = document.querySelector('.oneui-chat-history');
    if (!history) return;
    history.innerHTML = '';
    const dateHeader = document.createElement('div');
    dateHeader.className = 'oneui-chat-day-header';
    dateHeader.textContent = 'Assistant Virtuel';
    history.appendChild(dateHeader);

    const cfg = extractMoodleConfig();
    const myUserId = cfg.userid || currentUserId;

    getAiMessages().forEach(msg => {
      const isSelf = msg.useridfrom !== 0 && msg.useridfrom === myUserId;
      const timeStr = new Date(msg.timecreated * 1000).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
      const wrapper = document.createElement('div');
      wrapper.className = `oneui-message-wrapper ${isSelf ? 'self' : 'other'} ${!isSelf ? 'ia-bot-wrapper' : ''}`;
      wrapper.innerHTML = `<div class="oneui-message-bubble ${!isSelf ? 'oneui-message-bubble-ai' : ''}"><div class="oneui-message-text">${msg.text}</div></div><div class="oneui-message-time">${timeStr}</div>`;
      history.appendChild(wrapper);
    });
    history.scrollTop = history.scrollHeight;
  };

  const setAiSuggestions = (suggestions) => {
    const suggestionsContainer = document.querySelector('.ia-chatbot-suggestions');
    if (!suggestionsContainer) return;
    suggestionsContainer.innerHTML = '';
    suggestions.forEach(s => {
      const chip = document.createElement('button');
      chip.className = 'ia-suggestion-chip';
      chip.textContent = s;
      chip.addEventListener('click', () => {
        window.dispatchEvent(new CustomEvent('ultramoodle-ai-send-message', { detail: { text: s } }));
      });
      suggestionsContainer.appendChild(chip);
    });
  };

  const showAiTyping = () => {
    const history = document.querySelector('.oneui-chat-history');
    if (!history) return null;
    const wrap = document.createElement('div');
    wrap.className = 'oneui-message-wrapper other ai-typing-wrapper';
    wrap.innerHTML = `<div class="oneui-message-bubble oneui-message-bubble-ai" style="padding: 10px 14px !important;"><div class="ia-typing"><span></span><span></span><span></span></div></div>`;
    history.appendChild(wrap);
    history.scrollTop = history.scrollHeight;
    return wrap;
  };

  const removeAiTyping = (el) => { if (el && el.parentNode) el.parentNode.removeChild(el); };

  const stopResultCardEvents = ['click','mousedown','mouseup','pointerdown','pointerup','touchstart','touchend'];
  stopResultCardEvents.forEach(evt => {
    document.addEventListener(evt, (e) => {
      const card = e.target.closest && e.target.closest('.ia-result-card');
      if (card) {
        e.stopPropagation();
        e.stopImmediatePropagation();
        if (evt === 'click') {
          e.preventDefault();
          const url = card.getAttribute('href');
          const target = card.getAttribute('target') || '_self';
          if (url) window.open(url, target);
        }
      }
    }, true);
  });

  const handleAiChatMessage = async (text) => {
    const cfg = extractMoodleConfig();
    if (cfg.sesskey) currentSesskey = cfg.sesskey;
    if (cfg.userid) currentUserId = cfg.userid;

    const suggestionsContainer = document.querySelector('.ia-chatbot-suggestions');
    if (suggestionsContainer) suggestionsContainer.innerHTML = '';

    aiMessages.push({ useridfrom: currentUserId, text, timecreated: Date.now() / 1000 });
    renderAiChat();

    const typing = showAiTyping();
    try {
      const results = await deepSearchMoodle(text);
      removeAiTyping(typing);
      aiMessages.push({ useridfrom: 0, text: iaRenderResults(results, text), timecreated: Date.now() / 1000 });
      renderAiChat();
      setAiSuggestions(getAdaptedSuggestions(results, text));
    } catch (err) {
      removeAiTyping(typing);
      aiMessages.push({ useridfrom: 0, text: `❌ Une erreur est survenue : <em>${err.message}</em>`, timecreated: Date.now() / 1000 });
      renderAiChat();
    }
  };

  window.addEventListener('ultramoodle-ai-selected', () => {
    renderAiChat();
    setAiSuggestions(['Mes devoirs', 'Mes quiz', 'Mes deadlines']);
  });

  window.addEventListener('ultramoodle-ai-send-message', async (e) => {
    const text = e.detail && e.detail.text;
    if (!text) return;
    const inputField = document.querySelector('.oneui-input-field');
    if (inputField) { inputField.value = ''; inputField.style.height = 'auto'; }
    await handleAiChatMessage(text);
  });

  // NEW: Wait for the entire window to load before extracting the config
  window.addEventListener('load', extractMoodleConfig);

})();