(function () {
    'use strict';

    const MYEFREI_ORIGIN = 'https://www.myefrei.fr';
    const MOODLE_ORIGIN = 'https://moodle.myefrei.fr';
    
    // Focus settings
    let focusSettings = {
      myefrei: true,
      moodle: true,
      message: true
    };

    // Preloaded database cache
    let myefreiCache = {
      myefreiLoaded: false,
      myefreiLoading: false,
      messageLoaded: false,
      messageLoading: false,
      periods: [],
      grades: [],
      absences: [],
      documents: [],
      contacts: [],
      resources: [],
      news: []
    };

    // Conversational context state
    let lastSearchType = '';
    let newsOffset = 0;
    let ultraHistory = [];
    
    // DM conversation state machine
    // States: null, 'awaiting_recipient', 'awaiting_message'
    let dmState = null;
    let dmSelectedUser = null; // { id, name, email }
    
    // ULTRA mode state
    let aiMode = 'simple'; // 'simple' | 'ultra'
    let aiProvider = 'gemini'; // 'gemini' | 'openai' | 'claude' | 'grok'
    let aiApiKey = '';
    
    const myhubLogoUrl = chrome.runtime.getURL('img/logoMyHub.png');

    // Helper to fetch from myEfrei with absolute URL (with credentials for session cookies)
    const myeFetch = async (path, options = {}) => {
      const url = MYEFREI_ORIGIN + path;
      try {
        const res = await fetch(url, { ...options, credentials: 'include' });
        return res;
      } catch (e) {
        // Fallback: route through background service worker for CORS
        return new Promise((resolve, reject) => {
          chrome.runtime.sendMessage({ action: 'fetch', url, options: { ...options, credentials: 'include' } }, (response) => {
            if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
            if (response && response.success) {
              resolve({ ok: true, status: response.status, json: () => Promise.resolve(response.data), text: () => Promise.resolve(typeof response.data === 'string' ? response.data : JSON.stringify(response.data)) });
            } else {
              resolve({ ok: false, status: response ? response.status : 0, json: () => Promise.reject('not ok'), text: () => Promise.reject('not ok') });
            }
          });
        });
      }
    };

    // Preload MyEfrei (Grades, Absences, Documents, Resources)
    const preloadMyEfrei = async () => {
      if (!focusSettings.myefrei) return;
      if (myefreiCache.myefreiLoaded || myefreiCache.myefreiLoading) return;
      myefreiCache.myefreiLoading = true;
      console.log('[IA Chatbot] Synchronizing MyEfrei database in background...');
      try {
        // 1. Periods
        const periodsRes = await myeFetch('/api/rest/student/periods?withHistory=true');
        if (!periodsRes.ok) throw new Error('API Periods returned error');
        const periods = await periodsRes.json();
        myefreiCache.periods = Array.isArray(periods) ? periods : [];

        // 2. Parallel grades & absences
        const gradesPromises = [];
        const absencesPromises = [];
        myefreiCache.periods.forEach(p => {
          if (p.period && p.schoolYear) {
            gradesPromises.push(
              myeFetch(`/api/rest/student/grades?schoolYear=${p.schoolYear}&period=${p.period}`)
                .then(r => r.ok ? r.json() : null)
                .then(data => {
                  if (data) myefreiCache.grades.push({ period: p.period, schoolYear: p.schoolYear, data });
                })
                .catch(() => null)
            );
            absencesPromises.push(
              myeFetch(`/api/rest/student/absences?schoolYear=${p.schoolYear}&period=${p.period}`)
                .then(r => r.ok ? r.json() : null)
                .then(data => {
                  if (data) {
                    const arr = Array.isArray(data) ? data : (data.data || data.absences || []);
                    myefreiCache.absences.push(...arr.map(item => ({ ...item, period: p.period, schoolYear: p.schoolYear })));
                  }
                })
                .catch(() => null)
            );
          }
        });

        // 3. Documents
        const docsPromises = [
          myeFetch('/api/rest/student/schooling/documents').then(r => r.ok ? r.json() : []).catch(() => []),
          myeFetch('/api/rest/student/schooling/invoices').then(r => r.ok ? r.json() : []).catch(() => []),
          myeFetch('/api/rest/student/schooling/legacy-documents').then(r => r.ok ? r.json() : []).catch(() => [])
        ];

        // 4. Resources
        const resourcesPromise = myeFetch('/api/rest/common/resources/categories?with-resources=true')
          .then(r => r.ok ? r.json() : [])
          .then(async (cats) => {
            const catsArr = Array.isArray(cats) ? cats : [];
            const detailsPromises = catsArr.map(cat => {
              return myeFetch(`/api/rest/common/resources?category=${cat._id}&group=true`)
                .then(r => r.ok ? r.json() : null)
                .then(data => {
                  if (data) {
                    let parsed = [];
                    if (typeof data === 'object' && !Array.isArray(data)) {
                      parsed = Object.keys(data).map(key => ({ name: key, items: Array.isArray(data[key]) ? data[key] : [] }));
                    } else if (Array.isArray(data)) {
                      if (data.length > 0 && Array.isArray(data[0].resources)) {
                        parsed = data.map(g => ({ name: g.name || g.title || 'Autres', items: g.resources }));
                      } else {
                        parsed = [{ name: 'Documents', items: data }];
                      }
                    }
                    myefreiCache.resources.push({ category: cat.title, id: cat._id, groups: parsed });
                  }
                })
                .catch(() => null);
            });
            await Promise.all(detailsPromises);
          })
          .catch(() => {});

        // 5. News / Announcements (Fetch multiple pages for a rich local database)
        let newsData = [];
        try {
          const pages = [0, 1, 2];
          const pagePromises = pages.map(page => 
            myeFetch(`/api/rest/common/news?page=${page}`)
              .then(r => r.ok ? r.json() : null)
              .then(data => {
                if (data && Array.isArray(data.data)) {
                  return data.data;
                } else if (data && Array.isArray(data)) {
                  return data;
                }
                return [];
              })
              .catch(() => [])
          );
          const results = await Promise.all(pagePromises);
          newsData = results.flat();
        } catch (e) {
          console.warn('[IA Chatbot] Failed to preload common news pages, trying fallbacks...', e);
        }

        if (newsData.length === 0) {
          const newsEndpoints = [
            '/api/rest/student/announcements',
            '/api/rest/student/news',
            '/api/rest/common/news',
            '/api/rest/student/dashboard/announcements'
          ];
          for (const ep of newsEndpoints) {
            try {
              let res = await myeFetch(`${ep}?size=100&limit=100&pageSize=100`);
              if (!res.ok) {
                res = await myeFetch(ep);
              }
              if (res.ok) {
                const data = await res.json();
                if (data) {
                  const arr = Array.isArray(data) ? data : (data.content || data.data || data.items || data.announcements || []);
                  if (arr.length > 0) {
                    newsData = arr;
                    break;
                  }
                }
              }
            } catch(e) {}
          }
        }
        myefreiCache.news = newsData;

        await Promise.all([
          Promise.all(gradesPromises),
          Promise.all(absencesPromises),
          Promise.all(docsPromises).then(([docs, invoices, legacy]) => {
            myefreiCache.documents = [
              ...docs.map(d => ({ ...d, source: 'document', title: d.name || d.fileName || 'Document' })),
              ...invoices.map(d => ({ ...d, source: 'invoice', title: d.name || d.fileName || 'Facture' })),
              ...legacy.map(d => ({ ...d, source: 'legacy', title: d.name || d.fileName || 'Document Historique' }))
            ];
          }),
          resourcesPromise
        ]);

        myefreiCache.myefreiLoaded = true;
        myefreiCache.myefreiLoading = false;
        console.log('[IA Chatbot] MyEfrei cache populated successfully!');
      } catch (err) {
        myefreiCache.myefreiLoading = false;
        console.error('[IA Chatbot] Preloading MyEfrei failed:', err);
      }
    };

    // Preload Message (Contacts)
    const preloadMessage = async () => {
      if (!focusSettings.message) return;
      if (myefreiCache.messageLoaded || myefreiCache.messageLoading) return;
      myefreiCache.messageLoading = true;
      console.log('[IA Chatbot] Synchronizing Message (Contacts) database in background...');
      try {
        const contactsRes = await myeFetch('/api/rest/student/contacts');
        const data = contactsRes.ok ? await contactsRes.json() : [];
        myefreiCache.contacts = Array.isArray(data) ? data : [];
        myefreiCache.messageLoaded = true;
        myefreiCache.messageLoading = false;
        console.log('[IA Chatbot] Message cache populated successfully!');
      } catch (err) {
        myefreiCache.messageLoading = false;
        console.error('[IA Chatbot] Preloading Contacts failed:', err);
      }
    };

    // Helper to fetch via Background script (cross-origin bypass for Moodle)
    const fetchViaBackground = (url, options) => {
      return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ action: 'fetch', url, options }, (response) => {
          if (chrome.runtime.lastError) {
            return reject(new Error(chrome.runtime.lastError.message));
          }
          if (response && response.success) {
            resolve(response.data);
          } else {
            reject(new Error((response && response.error) || 'Failed to fetch via background'));
          }
        });
      });
    };

    // Moodle AJAX call via background service worker
    const callMoodleAjaxCrossPlatform = async (methodname, args, sesskey, userid) => {
      const url = `${MOODLE_ORIGIN}/lib/ajax/service.php?sesskey=${sesskey}&info=${methodname}`;
      try {
        const responseData = await fetchViaBackground(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify([{ index: 0, methodname, args }])
        });
        if (!responseData || !responseData[0]) throw new Error('Invalid AJAX response format');
        if (responseData[0].error) {
          const ex = responseData[0].exception;
          throw new Error(ex ? (typeof ex === 'object' ? (ex.message || JSON.stringify(ex)) : ex) : 'Moodle AJAX exception');
        }
        return responseData[0].data;
      } catch (e) {
        throw new Error(`Moodle AJAX failed via background proxy: ${e.message}`);
      }
    };

    // Moodle cross-platform actions
    const getMyCoursesCrossPlatform = async (sesskey, userid) => {
      try {
        return await callMoodleAjaxCrossPlatform('core_course_get_recent_courses', { userid }, sesskey, userid);
      } catch (e) { return []; }
    };

    const getCalendarEventsCrossPlatform = async (sesskey, userid) => {
      try {
        const now = Math.floor(Date.now() / 1000);
        const data = await callMoodleAjaxCrossPlatform('core_calendar_get_action_events_by_timesort', {
          timesortfrom: now - (30 * 24 * 60 * 60),
          timesortto: now + (150 * 24 * 60 * 60),
          limitnum: 50, aftereventid: 0
        }, sesskey, userid);
        return (data && data.events) ? data.events : [];
      } catch (e) { return []; }
    };

    const getCourseContentsCrossPlatform = async (courseId, sesskey, userid) => {
      try {
        const data = await callMoodleAjaxCrossPlatform('core_courseformat_get_state', { courseid: courseId }, sesskey, userid);
        if (data) {
          let state = typeof data === 'string' ? JSON.parse(data) : data;
          if (state && Array.isArray(state.section) && Array.isArray(state.cm)) {
            return state.section.map(sec => {
              const secModules = state.cm
                .filter(cm => String(cm.sectionid) === String(sec.id) || String(cm.sectionnumber) === String(sec.number))
                .map(cm => {
                  const mod = { id: cm.id, name: cm.name, modname: cm.module || '', url: cm.url || '', contents: [] };
                  if (cm.module === 'resource') mod.contents.push({ type: 'file', filename: cm.name, fileurl: cm.url });
                  return mod;
                });
              return { name: sec.title || sec.rawtitle || '', section: sec.number, modules: secModules };
            });
          }
        }
        return [];
      } catch (e) { return []; }
    };

    const searchMoodleContentCrossPlatform = async (query, sesskey, userid) => {
      try {
        const data = await callMoodleAjaxCrossPlatform('core_search_get_results', { query, filters: {}, page: 0 }, sesskey, userid);
        return (data && data.results) ? data.results : [];
      } catch { return []; }
    };

    const searchUsersCrossPlatform = async (query, sesskey, userid) => {
      const qCleaned = (query || '').trim();
      if (!qCleaned) return [];

      // Internal helper to perform a standard Moodle search try
      const doSingleSearch = async (sQuery) => {
        // Primary: core_message_message_search_users
        try {
          const data = await callMoodleAjaxCrossPlatform('core_message_message_search_users', { userid, search: sQuery, limitfrom: 0, limitnum: 10 }, sesskey, userid);
          const contacts = (data && data.contacts) ? data.contacts : [];
          const noncontacts = (data && data.noncontacts) ? data.noncontacts : [];
          if (contacts.length > 0 || noncontacts.length > 0) {
            return [...contacts, ...noncontacts];
          }
        } catch (e) {
          console.log('[IA Search] core_message_message_search_users failed for: ' + sQuery, e);
        }
        // Fallback 1: core_message_search_users
        try {
          const data2 = await callMoodleAjaxCrossPlatform('core_message_search_users', { userid, search: sQuery, limitfrom: 0, limitnum: 10 }, sesskey, userid);
          const c2 = (data2 && data2.contacts) ? data2.contacts : [];
          const nc2 = (data2 && data2.noncontacts) ? data2.noncontacts : [];
          if (c2.length > 0 || nc2.length > 0) return [...c2, ...nc2];
        } catch {}
        // Fallback 2: core_user_search_identity
        try {
          const data3 = await callMoodleAjaxCrossPlatform('core_user_search_identity', { query: sQuery, capabilities: [] }, sesskey, userid);
          return (data3 && data3.list) ? data3.list : [];
        } catch {
          return [];
        }
      };

      // 1. Try search with exact query
      let results = await doSingleSearch(qCleaned);
      if (results.length > 0) return results;

      // 2. Try search with swapped words (e.g. "Vibert Remi" -> "Remi Vibert")
      const words = qCleaned.split(/\s+/).filter(w => w.length >= 2);
      if (words.length >= 2) {
        // Swap first two words
        const swappedQuery = [words[1], words[0], ...words.slice(2)].join(' ');
        results = await doSingleSearch(swappedQuery);
        if (results.length > 0) return results;
      }

      // 3. Fallback: search for each word individually (length >= 3) and merge results
      const searchWords = words.filter(w => w.length >= 3);
      if (searchWords.length > 0) {
        const searchPromises = searchWords.map(word => doSingleSearch(word).catch(() => []));
        const allResultsArrays = await Promise.all(searchPromises);
        
        // Merge results and remove duplicates by user id
        const mergedMap = new Map();
        allResultsArrays.flat().forEach(u => {
          if (u && u.id && !mergedMap.has(u.id)) {
            mergedMap.set(u.id, u);
          }
        });
        
        // Prioritize results that match more search terms in their full name
        const mergedList = Array.from(mergedMap.values());
        mergedList.sort((a, b) => {
          const nameA = (a.fullname || ((a.firstname || '') + ' ' + (a.lastname || '')).trim()).toLowerCase();
          const nameB = (b.fullname || ((b.firstname || '') + ' ' + (b.lastname || '')).trim()).toLowerCase();
          
          const scoreA = searchWords.reduce((score, w) => score + (nameA.includes(w.toLowerCase()) ? 1 : 0), 0);
          const scoreB = searchWords.reduce((score, w) => score + (nameB.includes(w.toLowerCase()) ? 1 : 0), 0);
          
          return scoreB - scoreA; // More matches first
        });
        
        return mergedList;
      }

      return [];
    };

    // Algorithmic string utilities
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

    // Moodle Deep Search Engine (Cross-platform variant)
    const deepSearchMoodleCrossPlatform = async (query, sesskey, userid) => {
      const results = [];
      let allCourses = await getMyCoursesCrossPlatform(sesskey, userid);
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
      for (const c of courseHits.slice(0, 4)) {
        results.push({ type: 'course', icon: '📚', title: cleanCourseTitle(c.fullname), subtitle: c.shortname || c.fullname, url: `${MOODLE_ORIGIN}/course/view.php?id=${c.id}`, score: c._score });
      }

      try {
        const calendarEvents = await getCalendarEventsCrossPlatform(sesskey, userid);
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
              url: ev.url || ev.viewurl || `${MOODLE_ORIGIN}/calendar/view.php?view=day&time=${ev.timesort}`,
              score: isScopedSearch ? 0.90 + (score * 0.09) : Math.max(score, 0.4) + 0.15
            });
          }
        }
      } catch (e) {}

      try {
        const searchQ = isScopedSearch ? cleanQuery : query;
        if (searchQ) {
          const nativeResults = await searchMoodleContentCrossPlatform(searchQ, sesskey, userid);
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
      } catch (e) {}

      const coursesToScan = (isScopedSearch && targetCourse) ? [targetCourse] : allCourses.slice(0, 10);
      const contentPromises = coursesToScan.map(c => getCourseContentsCrossPlatform(c.id, sesskey, userid).then(sections => ({ course: c, sections })));
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
            results.push({ type: 'section', icon: '📂', title: secName, subtitle: `Section dans : ${cleanCourseTitle(course.fullname)}`, url: `${MOODLE_ORIGIN}/course/view.php?id=${course.id}#section-${section.section}`, score: isScopedSearch ? 0.90 + (secScore * 0.09) : secScore });
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
              results.push({ type: mod.modname || 'module', icon: moduleTypeIcon(mod), title: modName, subtitle: `${cleanCourseTitle(course.fullname)}${secName ? ' › ' + secName : ''}`, url: mod.url || `${MOODLE_ORIGIN}/course/view.php?id=${course.id}`, score: isScopedSearch ? 0.90 + (modScore * 0.09) : modScore });
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
                results.push({ type: 'file', icon: fileIcon, title: fname, subtitle: `${cleanCourseTitle(course.fullname)} › ${modName}${secName ? ' › ' + secName : ''}`, url: file.fileurl || mod.url || `${MOODLE_ORIGIN}/course/view.php?id=${course.id}`, score: isScopedSearch ? 0.90 + (fileScore * 0.09) : fileScore, ext });
              }
            }
          }
        }
      }

      if (!isScopedSearch) {
        try {
          const userHits = await searchUsersCrossPlatform(query, sesskey, userid);
          for (const u of userHits.slice(0, 2)) {
            const fullname = u.fullname || ((u.firstname || '') + ' ' + (u.lastname || '')).trim();
            if (!fullname) continue;
            results.push({ type: 'user', icon: '👤', title: fullname, subtitle: u.email || '', url: `${MOODLE_ORIGIN}/user/profile.php?id=${u.id}`, score: fuzzyScore(query, fullname) + 0.1, userId: u.id });
          }
        } catch (e) {}
      }

      const seen = new Set();
      return results
        .filter(r => { if (seen.has(r.url)) return false; seen.add(r.url); return true; })
        .filter(r => r.score >= 0.5)
        .sort((a, b) => b.score - a.score)
        .slice(0, 4);
    };

    // Unified Search Engine (MyEfrei database + Moodle cross-platform fallback)
    const searchMyEfreiAndMoodle = async (query) => {
      const results = [];
      let normQuery = normalizeStr(query);
      if (!normQuery) return [];

      // Strip direct messaging intents
      const dmRegex = /^(?:envoyer\s+un\s+dm\s+a\s+|envoyer\s+un\s+message\s+a\s+|envoyer\s+un\s+dm\s+|envoyer\s+un\s+message\s+|dm\s+a\s+|message\s+a\s+)(.+)$/i;
      const match = normQuery.match(dmRegex);
      if (match && match[1] && match[1].trim()) {
        query = match[1].trim();
      }

      // A. Search MyEfrei Grades
      if (focusSettings.myefrei && myefreiCache.grades.length > 0) {
        myefreiCache.grades.forEach(periodObj => {
          const ues = periodObj.data && (periodObj.data.ues || (Array.isArray(periodObj.data) ? periodObj.data : (periodObj.data.grades && periodObj.data.grades.ues)));
          if (Array.isArray(ues)) {
            ues.forEach(ue => {
              const ueName = ue.name || '';
              const ueScore = fuzzyScore(query, ueName);
              if (ueScore >= 0.5) {
                const avgVal = ue.grade != null ? ue.grade : (ue.average != null ? ue.average : null);
                results.push({
                  type: 'mye-grade-ue',
                  icon: '📊',
                  title: `Moyenne UE : ${ueName}`,
                  subtitle: `Semestre ${periodObj.period} (${periodObj.schoolYear}) • Coef: ${ue.coef || ue.ectsAttempted || 1}`,
                  url: MYEFREI_ORIGIN + '/portal/student/grades',
                  score: Math.min(ueScore + 0.15, 1.0),
                  meta: { average: avgVal != null ? `${avgVal}/20` : 'Non noté' }
                });
              }

              const subjects = ue.modules || ue.courses || ue.subjects || [];
              if (Array.isArray(subjects)) {
                subjects.forEach(sub => {
                  const subName = sub.name || '';
                  const subScore = fuzzyScore(query, subName);
                  if (subScore >= 0.5) {
                    const average = sub.grade != null ? sub.grade : (sub.average != null ? sub.average : null);
                    results.push({
                      type: 'mye-grade-subject',
                      icon: '📚',
                      title: subName,
                      subtitle: `Matière dans l'UE : ${ueName} (${periodObj.period})`,
                      url: MYEFREI_ORIGIN + '/portal/student/grades',
                      score: Math.min(subScore + 0.15, 1.0),
                      meta: { average: average != null ? `${average}/20` : 'Non noté' }
                    });
                  }
                });
              }
            });
          }
        });
      }

      // B. Search Absences
      if (focusSettings.myefrei && myefreiCache.absences.length > 0) {
        let matchedAbs = [];
        myefreiCache.absences.forEach(item => {
          const courseName = item.moduleName || item.courseName || item.course || item.subject || 'Cours';
          const score = Math.max(fuzzyScore(query, courseName), fuzzyScore(query, 'absence'), fuzzyScore(query, 'retard'));
          if (score >= 0.5 || normQuery.includes('absence') || normQuery.includes('retard')) {
            matchedAbs.push({ item, score });
          }
        });
        matchedAbs.sort((a, b) => b.score - a.score);
        matchedAbs.slice(0, 3).forEach(({ item, score }) => {
          const isRetard = item.type === 'lateness' || item.type === 'late' || (item.label && item.label.toLowerCase().includes('retard'));
          const justified = item.justified === true || item.status === 'excused' || item.status === 'justified';
          const dateStr = item.startDateTime || item.date || item.start || '';
          let formattedDate = 'Date inconnue';
          if (dateStr) {
            try {
              formattedDate = new Date(dateStr).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
            } catch(e) {}
          }
          results.push({
            type: 'mye-absence',
            icon: isRetard ? '⏳' : '🛑',
            title: `${isRetard ? 'Retard' : 'Absence'} : ${item.moduleName || item.courseName || item.course || item.subject || 'Cours'}`,
            subtitle: `${formattedDate} • ${justified ? 'Excusé(e)' : 'Non excusé(e)'}`,
            url: MYEFREI_ORIGIN + '/portal/student/absences',
            score: normQuery.includes('absence') || normQuery.includes('retard') ? 0.95 : Math.min(score + 0.15, 1.0),
            meta: { justified }
          });
        });
      }

      // C. Search Documents
      if (focusSettings.myefrei && myefreiCache.documents.length > 0) {
        myefreiCache.documents.forEach(doc => {
          const score = fuzzyScore(query, doc.title || '');
          if (score >= 0.5) {
            let downloadUrl = MYEFREI_ORIGIN + `/api/rest/student/schooling/documents/${doc.id}/download`;
            if (doc.source === 'invoice') downloadUrl = MYEFREI_ORIGIN + `/api/rest/student/schooling/invoices/${doc.id}/download`;
            else if (doc.source === 'legacy') downloadUrl = MYEFREI_ORIGIN + `/api/rest/student/schooling/legacy-documents/${doc.id}/download`;

            results.push({
              type: 'mye-document',
              icon: doc.source === 'invoice' ? '🧾' : '📄',
              title: doc.title,
              subtitle: `${doc.category || 'Scolarité'} • Téléchargement`,
              url: downloadUrl,
              score: Math.min(score + 0.15, 1.0),
              isDownload: true
            });
          }
        });
      }

      // D. Search Contacts
      if (focusSettings.message && myefreiCache.contacts.length > 0) {
        myefreiCache.contacts.forEach(cat => {
          const catTitle = cat.title || '';
          const contacts = cat.contacts || [];
          contacts.forEach(c => {
            const score = Math.max(fuzzyScore(query, c.title || ''), fuzzyScore(query, c.jobTitle || ''), fuzzyScore(query, catTitle) * 0.7);
            if (score >= 0.5) {
              const absoluteUrl = c.link ? (c.link.startsWith('/') ? MYEFREI_ORIGIN + c.link : c.link) : '';
              results.push({
                type: 'mye-contact',
                icon: c.type === 'staff' ? '👤' : '🏢',
                title: c.title,
                subtitle: `${c.jobTitle || 'Service'} • ${catTitle}`,
                url: absoluteUrl,
                score: score * 0.7,
                meta: { email: c.email || '', phone: c.phone || '', azureId: c.azureId || '', isStaff: c.type === 'staff' }
              });
            }
          });
        });
      }

      // E. Search Resources
      if (focusSettings.myefrei && myefreiCache.resources.length > 0) {
        myefreiCache.resources.forEach(cat => {
          cat.groups.forEach(group => {
            group.items.forEach(resItem => {
              const rTitle = resItem.title || resItem.name || '';
              const score = Math.max(fuzzyScore(query, rTitle), fuzzyScore(query, resItem.description || '') * 0.7);
              if (score >= 0.5) {
                results.push({
                  type: 'mye-resource',
                  icon: '📁',
                  title: rTitle,
                  subtitle: `Ressources › ${cat.category} › ${group.name}`,
                  url: MYEFREI_ORIGIN + `/api/rest/common/resources/${resItem._id}/file`,
                  score: score * 0.65,
                  isDownload: true
                });
              }
            });
          });
        });
      }

      // E.2. Search News / Announcements
      if (focusSettings.myefrei && Array.isArray(myefreiCache.news) && myefreiCache.news.length > 0) {
        const isNewsQuery = normQuery.includes('news') || normQuery.includes('actualit') || normQuery.includes('annonce') || normQuery.includes('actu');
        
        // Sort a copy of news chronologically (latest first) to assign scores properly
        const chronoNews = [...myefreiCache.news].sort((a, b) => {
          const dateA = new Date(a.date || a.createdAt || a.publishDate || a.publishedAt || a.publicationDate || 0).getTime();
          const dateB = new Date(b.date || b.createdAt || b.publishDate || b.publishedAt || b.publicationDate || 0).getTime();
          return dateB - dateA;
        });

        chronoNews.forEach((item, index) => {
          const title = item.title || item.subject || item.header || '';
          const content = item.content || item.body || item.text || item.description || item.head || '';
          let score = Math.max(fuzzyScore(query, title), fuzzyScore(query, content) * 0.7);
          
          if (isNewsQuery) {
            // Assign a high score starting from 0.9 and decreasing slightly to maintain chronological order in results
            score = Math.max(score, 0.9 - (index * 0.01));
          }
          
          if (score >= 0.5) {
            results.push({
              type: 'mye-news',
              icon: '📰',
              title: title,
              subtitle: content.replace(/<[^>]*>/g, '').substring(0, 120) + (content.length > 120 ? '...' : ''),
              url: item.link || item.url || (MYEFREI_ORIGIN + `/portal/student/home#news-${item.id || item._id || ''}`),
              score: score,
              meta: item
            });
          }
        });
      }

      // F. Fallback Search Moodle if config present
      if (focusSettings.moodle) {
        try {
          const storage = await new Promise(resolve => {
            chrome.storage.local.get(['moodle_sesskey', 'moodle_userid'], resolve);
          });
          if (storage && storage.moodle_sesskey && storage.moodle_userid) {
            const moodleResults = await deepSearchMoodleCrossPlatform(query, storage.moodle_sesskey, parseInt(storage.moodle_userid, 10));
            results.push(...moodleResults.map(r => ({ ...r, score: r.score * 0.85 })));
          }
        } catch (e) {
          console.warn('[IA Search] Cross Moodle failed:', e);
        }
      }

      const seen = new Set();
      return results
        .filter(r => {
          const key = `${r.type}-${r.title}-${r.url}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, 6);
    };

    // MyEfrei Render results HTML
    const myeRenderResults = (results, query) => {
      const normQuery = normalizeStr(query);
      let aiSummaryHTML = '';

      if (focusSettings.myefrei) {
        const hasNotesKeyword = normQuery.includes('note') || normQuery.includes('grade') || normQuery.includes('moyenne') || normQuery.includes('bulletin') || normQuery.includes('resultat') || normQuery.includes('combien') || results.some(r => r.type === 'mye-grade-ue' || r.type === 'mye-grade-subject');
        const hasAbsenceKeyword = normQuery.includes('absence') || normQuery.includes('absent') || normQuery.includes('retard') || normQuery.includes('manqu') || normQuery.includes('justif') || results.some(r => r.type === 'mye-absence');
        const hasDocsKeyword = normQuery.includes('document') || normQuery.includes('facture') || normQuery.includes('attestation') || normQuery.includes('justificatif') || normQuery.includes('schooling') || normQuery.includes('legacy') || results.some(r => r.type === 'mye-document');
        const hasContactsKeyword = normQuery.includes('contact') || normQuery.includes('prof') || normQuery.includes('enseignant') || normQuery.includes('scolarite') || normQuery.includes('administration') || normQuery.includes('mail') || normQuery.includes('telephone') || results.some(r => r.type === 'mye-contact');
        const hasResourcesKeyword = normQuery.includes('ressource') || normQuery.includes('wifi') || normQuery.includes('logiciel') || normQuery.includes('outils') || normQuery.includes('bibliotheque') || normQuery.includes('lien') || normQuery.includes('utile') || results.some(r => r.type === 'mye-resource');
        const hasMoodleKeyword = normQuery.includes('moodle') || normQuery.includes('devoir') || normQuery.includes('deadline') || normQuery.includes('echeance') || normQuery.includes('travail') || normQuery.includes('cours') || results.some(r => ['course', 'deadline', 'file', 'activity', 'section', 'module'].includes(r.type));
        
        const wantsMore = normQuery.includes('plus') || 
                          normQuery.includes('more') || 
                          normQuery.includes('tout') || 
                          normQuery.includes('liste') || 
                          normQuery.includes('suiv') || 
                          normQuery.includes('autr') || 
                          normQuery.includes('ancien') || 
                          normQuery.includes('suite') || 
                          normQuery.includes('encore') || 
                          normQuery.includes('next');

        let hasNewsKeyword = normQuery.includes('news') || normQuery.includes('actualit') || normQuery.includes('annonce') || normQuery.includes('actu');
        
        const isPagination = wantsMore && lastSearchType === 'news';
        if (hasNewsKeyword && !isPagination) {
          newsOffset = 0;
        }

        if (isPagination && !hasNotesKeyword && !hasAbsenceKeyword && !hasDocsKeyword && !hasContactsKeyword && !hasResourcesKeyword && !hasMoodleKeyword) {
          hasNewsKeyword = true;
        }

        if (hasNotesKeyword) {
          lastSearchType = 'grades';
        } else if (hasAbsenceKeyword) {
          lastSearchType = 'absences';
        } else if (hasNewsKeyword) {
          lastSearchType = 'news';
        } else if (hasDocsKeyword) {
          lastSearchType = 'documents';
        } else if (hasContactsKeyword) {
          lastSearchType = 'contacts';
        } else if (hasMoodleKeyword) {
          lastSearchType = 'moodle';
        } else if (hasResourcesKeyword) {
          lastSearchType = 'resources';
        }

        if (hasNotesKeyword) {
          let notesText = "";
          let bestSubjectMatch = null;
          let bestSubjectScore = 0.5;

          const detectSemesterInQuery = (q) => {
            const m = q.match(/\bsemestres?\s*(\d+)\b/i) || q.match(/\bs\s*(\d+)\b/i);
            return m ? m[1] : null;
          };

          const cleanSubjectQuery = (q) => {
            return q
              .replace(/(j|d|l|c)'/gi, ' ')
              .replace(/\b(notes?|grades?|moyennes?|bulletins?|resultats?|evaluations?|devoirs?|controles?|examens?|evals?|donne|moi|ma|mon|mes|le|la|les|du|de|un|une|generale|g|semestres?|s\d+|combien|ai|eu|a|pour|sur|en|quelle|quel|quels|quelles|ma|mon|mes|ta|ton|tes|sa|son|ses|notre|votre|leur|leurs|c|t|m|s|d|l)\b/g, '')
              .replace(/\b(au|aux|en|dans|de|du|d'|en)\b/g, '')
              .replace(/\d+/g, '')
              .replace(/\s+/g, ' ')
              .trim();
          };

          const targetSem = detectSemesterInQuery(normQuery);
          const periodsToSearch = targetSem 
            ? myefreiCache.grades.filter(g => {
                const pStr = String(g.period).toLowerCase();
                return pStr === targetSem || pStr === `s${targetSem}` || pStr.includes(`s${targetSem}`) || pStr.includes(targetSem);
              })
            : myefreiCache.grades;

          const strippedQuery = cleanSubjectQuery(normQuery);

          if (strippedQuery.length > 2) {
            periodsToSearch.forEach(periodObj => {
              const ues = periodObj.data && (periodObj.data.ues || (Array.isArray(periodObj.data) ? periodObj.data : (periodObj.data.grades && periodObj.data.grades.ues)));
              if (Array.isArray(ues)) {
                ues.forEach(ue => {
                  const ueName = ue.name || '';
                  const ueScore = fuzzyScore(strippedQuery, ueName);
                  const ueGrade = ue.grade != null ? ue.grade : (ue.average != null ? ue.average : null);
                  
                  if (ueScore >= bestSubjectScore && ueGrade != null) {
                    bestSubjectScore = ueScore;
                    bestSubjectMatch = { name: ueName, grade: ueGrade };
                  }

                  const subjects = ue.modules || ue.subjects || ue.courses || [];
                  if (Array.isArray(subjects)) {
                    subjects.forEach(sub => {
                      const subName = sub.name || '';
                      const subScore = fuzzyScore(strippedQuery, subName);
                      const subGrade = sub.grade != null ? sub.grade : (sub.average != null ? sub.average : null);
                      
                      if (subScore >= bestSubjectScore && subGrade != null) {
                        bestSubjectScore = subScore;
                        bestSubjectMatch = { name: subName, grade: subGrade };
                      }
                    });
                  }
                });
              }
            });
          }

          if (bestSubjectMatch) {
            notesText = `Vous avez eu <strong>${bestSubjectMatch.grade}</strong> en <strong>${bestSubjectMatch.name}</strong>.`;
          } else {
            const sortedGrades = [...periodsToSearch].sort((a, b) => {
              if (a.schoolYear !== b.schoolYear) {
                return b.schoolYear.localeCompare(a.schoolYear);
              }
              return b.period.localeCompare(a.period);
            });
            const latestPeriod = sortedGrades[0];

            if (latestPeriod) {
              const ues = latestPeriod.data && (latestPeriod.data.ues || (Array.isArray(latestPeriod.data) ? latestPeriod.data : (latestPeriod.data.grades && latestPeriod.data.grades.ues)));
              let generalAverage = null;

              if (Array.isArray(ues)) {
                let totalWeightedSum = 0;
                let totalCoef = 0;
                let fallbackSum = 0;
                let fallbackCoef = 0;

                ues.forEach(ue => {
                  let ueAverage = ue.grade != null ? parseFloat(ue.grade) : (ue.average != null ? parseFloat(ue.average) : null);
                  if (isNaN(ueAverage)) ueAverage = null;
                  
                  const subjects = ue.modules || ue.subjects || ue.courses || [];
                  if (ueAverage == null && Array.isArray(subjects) && subjects.length > 0) {
                    let subSum = 0;
                    let subCoefSum = 0;
                    subjects.forEach(sub => {
                      let subGrade = sub.grade != null ? parseFloat(sub.grade) : (sub.average != null ? parseFloat(sub.average) : null);
                      if (!isNaN(subGrade) && subGrade != null) {
                        const subCoef = sub.coef != null ? parseFloat(sub.coef) : (sub.coefficient != null ? parseFloat(sub.coefficient) : 1.0);
                        subSum += subGrade * subCoef;
                        subCoefSum += subCoef;
                      }
                    });
                    if (subCoefSum > 0) {
                      ueAverage = subSum / subCoefSum;
                    }
                  }

                  if (ueAverage != null) {
                    const ueCoef = ue.coef != null ? parseFloat(ue.coef) : (ue.ectsAttempted != null ? parseFloat(ue.ectsAttempted) : 1.0);
                    
                    if (subjects.length >= 2) {
                      totalWeightedSum += ueAverage * ueCoef;
                      totalCoef += ueCoef;
                    }
                    
                    fallbackSum += ueAverage * ueCoef;
                    fallbackCoef += ueCoef;
                  }
                });

                if (totalCoef > 0) {
                  generalAverage = totalWeightedSum / totalCoef;
                } else if (fallbackCoef > 0) {
                  generalAverage = fallbackSum / fallbackCoef;
                }
              }

              const modulesList = [];
              if (Array.isArray(ues)) {
                ues.forEach(ue => {
                  const subjects = ue.modules || ue.subjects || ue.courses || [];
                  if (Array.isArray(subjects) && subjects.length > 0) {
                    subjects.forEach(sub => {
                      const subGrade = sub.grade != null ? sub.grade : (sub.average != null ? sub.average : null);
                      if (subGrade != null) {
                        modulesList.push({ name: sub.name, grade: subGrade });
                      }
                    });
                  } else {
                    const ueGrade = ue.grade != null ? ue.grade : (ue.average != null ? ue.average : null);
                    if (ueGrade != null) {
                      modulesList.push({ name: ue.name, grade: ueGrade });
                    }
                  }
                });
              }

              let avgStr = generalAverage != null ? `<strong>${Number(generalAverage).toFixed(2)}</strong>` : "non spécifiée";
              notesText = `Votre moyenne générale est de ${avgStr}.`;
              
              if (modulesList.length > 0) {
                notesText += `<br><br>Voici vos moyennes par module :`;
                notesText += `<div style="margin-top: 10px; display: flex; flex-direction: column; gap: 4px;">`;
                modulesList.forEach(m => {
                  notesText += `
                    <div class="mye-ai-summary-module-row">
                      <span style="font-weight: 500;">${m.name}</span>
                      <strong>${Number(m.grade).toFixed(2)}</strong>
                    </div>
                  `;
                });
                notesText += `</div>`;
              }
            } else {
              notesText = targetSem ? `Aucune note enregistrée pour le semestre ${targetSem}.` : "Vous n'avez pas encore de notes enregistrées.";
            }
          }
          
          aiSummaryHTML = `
            <div class="mye-ai-summary-card" style="background: linear-gradient(135deg, #eef2ff 0%, #e0e7ff 100%); border: 1.5px solid #c7d2fe; border-radius: 20px; padding: 20px; margin-bottom: 20px; font-family: 'Outfit', sans-serif;">
              <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 8px;">
                <img src="${myhubLogoUrl}" class="mye-chat-bot-avatar-img" alt="myHub">
                <strong style="color: #4f46e5; font-size: 15px; text-transform: uppercase; letter-spacing: 0.5px;">Assistant IA</strong>
              </div>
              <div style="font-size: 15px; color: #1e293b; line-height: 1.6; font-weight: 500;">
                ${notesText}
              </div>
            </div>
          `;
        } 
        else if (hasAbsenceKeyword) {
          let absencesCount = 0;
          let latenessesCount = 0;
          let unjustifiedAbsences = [];

          myefreiCache.absences.forEach(item => {
            const isRetard = item.type === 'lateness' || item.type === 'late' || (item.label && item.label.toLowerCase().includes('retard'));
            if (isRetard) {
              latenessesCount++;
            } else {
              absencesCount++;
            }
            const justified = item.justified === true || item.status === 'excused' || item.status === 'justified';
            if (!justified) {
              unjustifiedAbsences.push(item);
            }
          });

          let absencesText = `Vous avez <strong>${absencesCount}</strong> absences et <strong>${latenessesCount}</strong> retards.`;

          if (unjustifiedAbsences.length > 0) {
            unjustifiedAbsences.sort((a, b) => new Date(a.startDateTime) - new Date(b.startDateTime));
            const urgent = unjustifiedAbsences[0];
            const start = new Date(urgent.startDateTime);
            const limit = urgent.limitDate ? new Date(urgent.limitDate) : new Date(start.getTime() + 15 * 24 * 60 * 60 * 1000);
            const now = new Date();
            const diffTime = limit.getTime() - now.getTime();
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
            
            const formattedStart = start.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
            const formattedLimit = limit.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
            
            if (diffDays > 0) {
              absencesText += ` Vous devez justifier votre absence du <strong>${formattedStart}</strong> avant le <strong>${formattedLimit}</strong>, il reste <strong>${diffDays}</strong> jour${diffDays !== 1 ? 's' : ''}.`;
            }
          }

          aiSummaryHTML = `
            <div class="mye-ai-summary-card" style="background: linear-gradient(135deg, #eef2ff 0%, #e0e7ff 100%); border: 1.5px solid #c7d2fe; border-radius: 20px; padding: 20px; margin-bottom: 20px; font-family: 'Outfit', sans-serif;">
              <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 8px;">
                <img src="${myhubLogoUrl}" class="mye-chat-bot-avatar-img" alt="myHub">
                <strong style="color: #4f46e5; font-size: 15px; text-transform: uppercase; letter-spacing: 0.5px;">Assistant IA</strong>
              </div>
              <div style="font-size: 15px; color: #1e293b; line-height: 1.6; font-weight: 500;">
                ${absencesText}
              </div>
            </div>
          `;
        }
        else if (hasMoodleKeyword) {
          let moodleText = "";
          const deadlines = results.filter(r => r.type === 'deadline');
          const courses = results.filter(r => r.type === 'course');

          if (deadlines.length > 0) {
            moodleText = `Vous avez <strong>${deadlines.length}</strong> devoir${deadlines.length > 1 ? 's' : ''}/échéance${deadlines.length > 1 ? 's' : ''} à venir sur Moodle.`;
            moodleText += `<br><br>Voici vos prochaines échéances :`;
            moodleText += `<div style="margin-top: 10px; display: flex; flex-direction: column; gap: 4px;">`;
            deadlines.slice(0, 3).forEach(dl => {
              moodleText += `
                <div class="mye-ai-summary-module-row">
                  <span style="font-weight: 500;">${dl.title}</span>
                  <a href="${dl.url}" target="_blank" style="color: #4f46e5; text-decoration: none; font-size: 13px; font-weight: 600;">Voir</a>
                </div>
              `;
            });
            moodleText += `</div>`;
          } else if (courses.length > 0) {
            moodleText = `Voici vos cours Moodle correspondants :`;
            moodleText += `<div style="margin-top: 10px; display: flex; flex-direction: column; gap: 4px;">`;
            courses.slice(0, 3).forEach(c => {
              moodleText += `
                <div class="mye-ai-summary-module-row">
                  <span style="font-weight: 500;">${c.title}</span>
                  <a href="${c.url}" target="_blank" style="color: #4f46e5; text-decoration: none; font-size: 13px; font-weight: 600;">Accéder</a>
                </div>
              `;
            });
            moodleText += `</div>`;
          } else {
            moodleText = "Aucune échéance ou cours Moodle particulier trouvé pour cette recherche.";
          }

          aiSummaryHTML = `
            <div class="mye-ai-summary-card" style="background: linear-gradient(135deg, #eef2ff 0%, #e0e7ff 100%); border: 1.5px solid #c7d2fe; border-radius: 20px; padding: 20px; margin-bottom: 20px; font-family: 'Outfit', sans-serif;">
              <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 8px;">
                <img src="${myhubLogoUrl}" class="mye-chat-bot-avatar-img" alt="myHub">
                <strong style="color: #4f46e5; font-size: 15px; text-transform: uppercase; letter-spacing: 0.5px;">Assistant IA</strong>
              </div>
              <div style="font-size: 15px; color: #1e293b; line-height: 1.6; font-weight: 500;">
                ${moodleText}
              </div>
            </div>
          `;
        }
        else if (hasDocsKeyword) {
          let docsText = `Vous avez <strong>${myefreiCache.documents.length}</strong> document${myefreiCache.documents.length > 1 ? 's' : ''} administratif${myefreiCache.documents.length > 1 ? 's' : ''} disponible${myefreiCache.documents.length > 1 ? 's' : ''} dans votre espace.`;
          
          if (myefreiCache.documents.length > 0) {
            docsText += `<br><br>Voici vos documents récents :`;
            docsText += `<div style="margin-top: 10px; display: flex; flex-direction: column; gap: 4px;">`;
            myefreiCache.documents.slice(0, 3).forEach(doc => {
              let downloadUrl = MYEFREI_ORIGIN + `/api/rest/student/schooling/documents/${doc.id}/download`;
              if (doc.source === 'invoice') downloadUrl = MYEFREI_ORIGIN + `/api/rest/student/schooling/invoices/${doc.id}/download`;
              else if (doc.source === 'legacy') downloadUrl = MYEFREI_ORIGIN + `/api/rest/student/schooling/legacy-documents/${doc.id}/download`;

              docsText += `
                <div class="mye-ai-summary-module-row">
                  <span style="font-weight: 500;">${doc.title}</span>
                  <a href="${downloadUrl}" target="_blank" style="color: #4f46e5; text-decoration: none; font-size: 13px; font-weight: 600;">Télécharger</a>
                </div>
              `;
            });
            docsText += `</div>`;
          }

          aiSummaryHTML = `
            <div class="mye-ai-summary-card" style="background: linear-gradient(135deg, #eef2ff 0%, #e0e7ff 100%); border: 1.5px solid #c7d2fe; border-radius: 20px; padding: 20px; margin-bottom: 20px; font-family: 'Outfit', sans-serif;">
              <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 8px;">
                <img src="${myhubLogoUrl}" class="mye-chat-bot-avatar-img" alt="myHub">
                <strong style="color: #4f46e5; font-size: 15px; text-transform: uppercase; letter-spacing: 0.5px;">Assistant IA</strong>
              </div>
              <div style="font-size: 15px; color: #1e293b; line-height: 1.6; font-weight: 500;">
                ${docsText}
              </div>
            </div>
          `;
        }
        else if (hasContactsKeyword) {
          let contactsText = "Voici les contacts administratifs et enseignants disponibles :";
          let contactsList = [];

          myefreiCache.contacts.forEach(cat => {
            const catTitle = cat.title || '';
            const contacts = cat.contacts || [];
            contacts.forEach(c => {
              if (contactsList.length < 3) {
                contactsList.push({ name: c.title, detail: `${c.jobTitle || 'Service'} (${catTitle})`, email: c.email });
              }
            });
          });

          if (contactsList.length > 0) {
            contactsText += `<div style="margin-top: 10px; display: flex; flex-direction: column; gap: 4px;">`;
            contactsList.forEach(c => {
              contactsText += `
                <div class="mye-ai-summary-module-row">
                  <div style="display: flex; flex-direction: column;">
                    <span style="font-weight: 500;">${c.name}</span>
                    <span style="font-size: 12px; color: #64748b; margin-top: 2px;">${c.detail}</span>
                  </div>
                  ${c.email ? `<a href="mailto:${c.email}" style="color: #4f46e5; text-decoration: none; font-size: 13px; font-weight: 600;">E-mail</a>` : ''}
                </div>
              `;
            });
            contactsText += `</div>`;
          } else {
            contactsText = "Aucun contact enregistré trouvé.";
          }

          aiSummaryHTML = `
            <div class="mye-ai-summary-card" style="background: linear-gradient(135deg, #eef2ff 0%, #e0e7ff 100%); border: 1.5px solid #c7d2fe; border-radius: 20px; padding: 20px; margin-bottom: 20px; font-family: 'Outfit', sans-serif;">
              <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 8px;">
                <img src="${myhubLogoUrl}" class="mye-chat-bot-avatar-img" alt="myHub">
                <strong style="color: #4f46e5; font-size: 15px; text-transform: uppercase; letter-spacing: 0.5px;">Assistant IA</strong>
              </div>
              <div style="font-size: 15px; color: #1e293b; line-height: 1.6; font-weight: 500;">
                ${contactsText}
              </div>
            </div>
          `;
        }
        else if (hasNewsKeyword) {
          let newsText = "";
          if (Array.isArray(myefreiCache.news) && myefreiCache.news.length > 0) {
            const sortedNews = [...myefreiCache.news].sort((a, b) => {
              const dateA = new Date(a.date || a.createdAt || a.publishDate || a.publishedAt || a.publicationDate || 0);
              const dateB = new Date(b.date || b.createdAt || b.publishDate || b.publishedAt || b.publicationDate || 0);
              return dateB - dateA;
            });

            const isPagination = wantsMore && lastSearchType === 'news';
            if (!isPagination) {
              newsOffset = 0;
            }

            const startIdx = newsOffset;
            const endIdx = startIdx + 3;

            if (startIdx >= sortedNews.length) {
              newsText = `<div style="color: #64748b; font-style: italic;">Il n'y a plus d'actualités disponibles dans MyEfrei.</div>`;
            } else {
              const topNews = sortedNews.slice(startIdx, endIdx);
              newsOffset = Math.min(endIdx, sortedNews.length);
              
              const titleText = isPagination ? "Voici les actualités suivantes de l'Efrei :" : "Voici les dernières actualités de l'Efrei :";
              newsText = `<div style="font-weight: 700; color: #1e293b; margin-bottom: 8px;">${titleText}</div>`;
              
              topNews.forEach(item => {
                const title = item.title || item.subject || item.header || 'Sans titre';
                const dateStr = item.date || item.createdAt || item.publishDate || item.publishedAt || item.publicationDate
                  ? new Date(item.date || item.createdAt || item.publishDate || item.publishedAt || item.publicationDate).toLocaleDateString('fr-FR')
                  : '';
                const url = item.link || item.url || (MYEFREI_ORIGIN + `/portal/student/home#news-${item.id || item._id || ''}`);
                
                newsText += `<div class="mye-ai-summary-module-row" style="padding: 8px 0; display: flex; justify-content: space-between; align-items: center;">
                  <a href="${url}" target="_blank" style="font-weight: 600; color: #1b4332; text-decoration: none; display: flex; flex-direction: column; flex: 1;">
                    <span>${title}</span>
                    ${dateStr ? `<span style="font-size: 11px; color: #16a34a; font-weight: normal; margin-top: 2px;">Publié le ${dateStr}</span>` : ''}
                  </a>
                  <a href="${url}" target="_blank" style="color: #16a34a; text-decoration: none; font-size: 13px; font-weight: 600; margin-left: 15px; display: flex; align-items: center; gap: 4px;">
                    <span>Lire</span>
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
                  </a>
                </div>`;
              });
            }
          } else {
            newsText = `Aucune actualité récente trouvée dans MyEfrei.`;
          }

          aiSummaryHTML = `
            <div class="mye-ai-summary-card" style="background: linear-gradient(135deg, #f0fdf4 0%, #dcfce7 100%); border: 1.5px solid #bbf7d0; border-radius: 20px; padding: 20px; margin-bottom: 20px; font-family: 'Outfit', sans-serif;">
              <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 8px;">
                <img src="${myhubLogoUrl}" class="mye-chat-bot-avatar-img" alt="myHub">
                <strong style="color: #16a34a; font-size: 15px; text-transform: uppercase; letter-spacing: 0.5px;">ASSISTANT IA - ACTUALITÉS</strong>
              </div>
              <div style="font-size: 15px; color: #1e293b; line-height: 1.6; font-weight: 500;">
                ${newsText}
              </div>
            </div>
          `;
        }
        else if (hasResourcesKeyword) {
          let resourcesText = "Voici les ressources utiles disponibles sur le portail :";
          let resourcesList = [];

          myefreiCache.resources.forEach(cat => {
            const catName = cat.category || cat.title || 'Ressources';
            const groups = cat.groups || [];
            groups.forEach(group => {
              const items = group.items || [];
              items.forEach(resItem => {
                if (resourcesList.length < 3) {
                  resourcesList.push({
                    name: resItem.title || resItem.name || 'Fichier',
                    detail: `${catName} › ${group.name}`,
                    url: MYEFREI_ORIGIN + `/api/rest/common/resources/${resItem._id}/file`
                  });
                }
              });
            });
          });

          if (resourcesList.length > 0) {
            resourcesText += `<div style="margin-top: 10px; display: flex; flex-direction: column; gap: 4px;">`;
            resourcesList.forEach(r => {
              resourcesText += `
                <div class="mye-ai-summary-module-row">
                  <div style="display: flex; flex-direction: column;">
                    <span style="font-weight: 500;">${r.name}</span>
                    <span style="font-size: 12px; color: #64748b; margin-top: 2px;">${r.detail}</span>
                  </div>
                  <a href="${r.url}" target="_blank" download style="color: #4f46e5; text-decoration: none; font-size: 13px; font-weight: 600;">Télécharger</a>
                </div>
              `;
            });
            resourcesText += `</div>`;
          } else {
            resourcesText = "Aucune ressource utile enregistrée.";
          }

          aiSummaryHTML = `
            <div class="mye-ai-summary-card" style="background: linear-gradient(135deg, #eef2ff 0%, #e0e7ff 100%); border: 1.5px solid #c7d2fe; border-radius: 20px; padding: 20px; margin-bottom: 20px; font-family: 'Outfit', sans-serif;">
              <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 8px;">
                <img src="${myhubLogoUrl}" class="mye-chat-bot-avatar-img" alt="myHub">
                <strong style="color: #4f46e5; font-size: 15px; text-transform: uppercase; letter-spacing: 0.5px;">Assistant IA</strong>
              </div>
              <div style="font-size: 15px; color: #1e293b; line-height: 1.6; font-weight: 500;">
                ${resourcesText}
              </div>
            </div>
          `;
        }
      }

      if (results.length === 0 && !aiSummaryHTML) {
        const hasDmIntent = normQuery.includes('dm') || normQuery.includes('message direct') || normQuery.includes('envoyer un message');
        if (hasDmIntent) {
          return `
            <div class="mye-ai-summary-card" style="background: linear-gradient(135deg, #fee2e2 0%, #fef2f2 100%); border: 1.5px solid #fca5a5; border-radius: 20px; padding: 20px; margin-bottom: 20px; font-family: 'Outfit', sans-serif;">
              <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 8px;">
                <img src="${myhubLogoUrl}" class="mye-chat-bot-avatar-img" alt="myHub">
                <strong style="color: #ef4444; font-size: 15px; text-transform: uppercase; letter-spacing: 0.5px;">Messagerie Moodle</strong>
              </div>
              <div style="font-size: 15px; color: #1e293b; line-height: 1.6; font-weight: 500;">
                Pour envoyer un DM Moodle directement depuis cette interface, tapez <strong>"DM à [Nom de votre contact]"</strong> (ex: <em>"DM à Scolarité"</em> ou <em>"DM à Jean Dupont"</em>).<br><br>
                Vous pouvez également rechercher simplement le nom d'un contact et cliquer sur l'icône de discussion 💬 rouge à côté de sa fiche.
              </div>
            </div>
          `;
        }
        return `<div class="ia-no-results">Je n'ai trouvé aucun résultat correspondant dans MyEfrei ou Moodle.</div>`;
      }

      const typeLabel = {
        'mye-grade-ue': 'Moyenne UE',
        'mye-grade-subject': 'Matière',
        'mye-absence': 'Absence/Retard',
        'mye-document': 'Document',
        'mye-contact': 'Contact',
        'mye-resource': 'Ressources',
        'mye-news': 'Actualité',
        'course': 'Cours Moodle',
        'deadline': 'Deadline Moodle',
        'file': 'Fichier Moodle',
        'user': 'Utilisateur'
      };

      let html = '';
      if (results.length > 0) {
        html += `<div class="ia-results-header" style="font-size: 16px; font-weight: 700; color: #475569; margin-bottom: 16px;">${results.length} résultat${results.length > 1 ? 's' : ''} trouvé${results.length > 1 ? 's' : ''} pour <strong>"${query}"</strong></div>`;
      }
      
      html += aiSummaryHTML;
      
      if (results.length > 0) {
        html += `<div class="ia-results-list">`;
        for (const r of results) {
          const pct = Math.round(Math.min(r.score, 1) * 100);
          const label = typeLabel[r.type] || r.type;
          
          let extraHTML = '';
          let cardHref = r.url;
          if (r.type === 'mye-contact' || r.type === 'user') {
            cardHref = 'javascript:void(0);';
          }

          if (r.type === 'mye-grade-ue' || r.type === 'mye-grade-subject') {
            const avg = r.meta && r.meta.average;
            let color = '#2ecc71';
            if (avg && avg !== 'Non noté') {
              const parsed = parseFloat(avg);
              if (!isNaN(parsed) && parsed < 10) color = '#e74c3c';
              else if (!isNaN(parsed) && parsed < 12) color = '#f39c12';
            }
            extraHTML = `<div class="mye-ai-grade-badge" style="background-color: ${color}; color: white; padding: 4px 8px; border-radius: 6px; font-weight: 700; font-size: 14px; margin-left: auto;">${avg}</div>`;
          } 
          else if (r.type === 'mye-contact') {
            const c = r.meta || {};
            let actions = '';
            if (c.email) {
              actions += `<a href="mailto:${c.email}" class="mye-ai-contact-btn" title="Envoyer un e-mail" style="display: flex; align-items: center; justify-content: center; width: 32px; height: 32px; border-radius: 50%; background: #e2e8f0; color: #475569; margin-left: 5px;"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path><polyline points="22,6 12,13 2,6"></polyline></svg></a>`;
              if (c.isStaff) {
                actions += `<a href="https://teams.microsoft.com/l/chat/0/0?users=${encodeURIComponent(c.email)}" target="_blank" class="mye-ai-contact-btn" title="Discuter sur Teams" style="display: flex; align-items: center; justify-content: center; width: 32px; height: 32px; border-radius: 50%; background: #e0e7ff; color: #4f46e5; margin-left: 5px;"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg></a>`;
              }
              actions += `<button class="mye-ai-contact-btn mye-dm-trigger-btn" data-email="${c.email || ''}" data-name="${r.title || ''}" title="Envoyer un DM Moodle" style="display: flex; align-items: center; justify-content: center; width: 32px; height: 32px; border-radius: 50%; background: #fee2e2; color: #ef4444; border: none; cursor: pointer; margin-left: 5px;"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg></button>`;
            }
            if (c.phone) {
              actions += `<a href="tel:${c.phone}" class="mye-ai-contact-btn" title="Téléphoner" style="display: flex; align-items: center; justify-content: center; width: 32px; height: 32px; border-radius: 50%; background: #ecfdf5; color: #059669; margin-left: 5px;"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path></svg></a>`;
            }
            extraHTML = `<div style="display: flex; align-items: center; margin-left: auto;">${actions}</div>`;
          }
          else if (r.type === 'user') {
            let actions = `<button class="mye-ai-contact-btn mye-dm-trigger-btn" data-userid="${r.userId || ''}" data-name="${r.title || ''}" title="Envoyer un DM Moodle" style="display: flex; align-items: center; justify-content: center; width: 32px; height: 32px; border-radius: 50%; background: #fee2e2; color: #ef4444; border: none; cursor: pointer; margin-left: 5px;"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg></button>`;
            extraHTML = `<div style="display: flex; align-items: center; margin-left: auto;">${actions}</div>`;
          }

          const isDownload = r.isDownload || false;

          html += `<a href="${cardHref}" target="_blank" class="ia-result-card mye-portal-result" ${isDownload ? 'download' : ''} style="display: flex !important; align-items: center; padding: 16px; border-radius: 16px; border: 1px solid rgba(0, 0, 0, 0.05); background: white; margin-bottom: 12px; text-decoration: none; color: inherit; transition: all 0.2s; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.02) !important;">
            <div class="ia-result-icon" style="font-size: 24px; margin-right: 16px; width: 44px; height: 44px; border-radius: 12px; background: #f1f5f9; display: flex; align-items: center; justify-content: center;">${r.icon}</div>
            <div class="ia-result-body" style="flex: 1; display: flex; flex-direction: column;">
              <div class="ia-result-title" style="font-weight: 700; font-size: 15px; color: #1e293b;">${r.title}</div>
              <div class="ia-result-subtitle" style="font-size: 12.5px; color: #64748b; margin-top: 3px;">${r.subtitle}</div>
              <div class="ia-result-meta" style="margin-top: 6px; display: flex; align-items: center; gap: 8px;">
                <span class="ia-result-type" style="font-size: 10px; font-weight: 700; color: #6366f1; background: #e0e7ff; padding: 2px 6px; border-radius: 4px;">${label}</span>
                <span class="ia-result-score" style="font-size: 11px; color: #94a3b8;">${pct}% match</span>
              </div>
            </div>
            ${extraHTML}
            <div class="ia-result-arrow" style="margin-left: 16px; color: #94a3b8;"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="display:block;"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg></div>
          </a>`;
        }
        html += '</div>';
      }

      return html;
    };

    // Helper to setup UI events
    const attachPortalChatEvents = () => {
      const toggleMyefrei = document.getElementById('mye-toggle-myefrei');
      const toggleMoodle = document.getElementById('mye-toggle-moodle');
      const toggleMessage = document.getElementById('mye-toggle-message');

      const saveSettings = () => {
        focusSettings.myefrei = toggleMyefrei.checked;
        focusSettings.moodle = toggleMoodle.checked;
        focusSettings.message = toggleMessage.checked;
        chrome.storage.local.set({
          focus_myefrei: focusSettings.myefrei,
          focus_moodle: focusSettings.moodle,
          focus_message: focusSettings.message
        });

        if (focusSettings.myefrei) {
          preloadMyEfrei();
        } else {
          myefreiCache.periods = [];
          myefreiCache.grades = [];
          myefreiCache.absences = [];
          myefreiCache.documents = [];
          myefreiCache.resources = [];
          myefreiCache.news = [];
          myefreiCache.myefreiLoaded = false;
          myefreiCache.myefreiLoading = false;
        }

        if (focusSettings.message) {
          preloadMessage();
        } else {
          myefreiCache.contacts = [];
          myefreiCache.messageLoaded = false;
          myefreiCache.messageLoading = false;
        }
      };

      if (toggleMyefrei) toggleMyefrei.addEventListener('change', saveSettings);
      if (toggleMoodle) toggleMoodle.addEventListener('change', saveSettings);
      if (toggleMessage) toggleMessage.addEventListener('change', saveSettings);

      // ── ULTRA Mode UI Handlers ──
      const modeSimpleBtn = document.getElementById('mye-mode-simple');
      const modeUltraBtn = document.getElementById('mye-mode-ultra');
      const ultraConfig = document.getElementById('mye-ultra-config');
      const providerSelect = document.getElementById('mye-ai-provider');
      const apiKeyInput = document.getElementById('mye-ai-apikey');
      const toggleKeyBtn = document.getElementById('mye-ai-toggle-key');
      const keyStatus = document.getElementById('mye-ai-key-status');

      const updateModeUI = () => {
        if (modeSimpleBtn) {
          if (aiMode === 'simple') {
            modeSimpleBtn.classList.add('mye-mode-active-simple');
          } else {
            modeSimpleBtn.classList.remove('mye-mode-active-simple');
          }
        }
        if (modeUltraBtn) {
          if (aiMode === 'ultra') {
            modeUltraBtn.classList.add('mye-mode-active-ultra');
          } else {
            modeUltraBtn.classList.remove('mye-mode-active-ultra');
          }
        }
        if (ultraConfig) ultraConfig.style.display = aiMode === 'ultra' ? 'block' : 'none';
      };

      if (modeSimpleBtn) modeSimpleBtn.addEventListener('click', () => {
        aiMode = 'simple';
        ultraHistory = [];
        chrome.storage.local.set({ ai_mode: 'simple' });
        updateModeUI();
      });
      if (modeUltraBtn) modeUltraBtn.addEventListener('click', () => {
        aiMode = 'ultra';
        ultraHistory = [];
        chrome.storage.local.set({ ai_mode: 'ultra' });
        updateModeUI();
      });

      if (providerSelect) providerSelect.addEventListener('change', () => {
        aiProvider = providerSelect.value;
        chrome.storage.local.set({ ai_provider: aiProvider });
      });

      if (apiKeyInput) {
        let saveTimer = null;
        apiKeyInput.addEventListener('input', () => {
          clearTimeout(saveTimer);
          saveTimer = setTimeout(() => {
            aiApiKey = apiKeyInput.value.trim();
            chrome.storage.local.set({ ai_apikey: aiApiKey });
            if (keyStatus) {
              keyStatus.textContent = aiApiKey ? '✓ Clé sauvegardée' : 'Entrez votre clé API';
              keyStatus.style.color = aiApiKey ? '#059669' : '#94a3b8';
            }
          }, 500);
        });
      }

      if (toggleKeyBtn && apiKeyInput) {
        toggleKeyBtn.addEventListener('click', () => {
          const isHidden = apiKeyInput.type === 'password';
          apiKeyInput.type = isHidden ? 'text' : 'password';
          toggleKeyBtn.textContent = isHidden ? '🔒' : '👁';
        });
      }

      const exitBtn = document.getElementById('mye-ai-exit-btn');
      if (exitBtn) {
        exitBtn.addEventListener('click', () => {
          window.location.href = MYEFREI_ORIGIN + '/portal/student/home';
        });
      }

      const landingInput = document.getElementById('mye-ai-search-input-landing');
      const landingSubmit = document.getElementById('mye-ai-search-submit-landing');
      const bottomInput = document.getElementById('mye-ai-search-input-bottom');
      const bottomSubmit = document.getElementById('mye-ai-search-submit-bottom');
      const backBtn = document.getElementById('mye-ai-back-btn');

      const executeSearch = async (text, isFromBottom = false) => {
        if (!text.trim()) return;
        
        const isLandingVisible = !document.getElementById('mye-ai-landing').classList.contains('mye-hidden');
        
        if (isLandingVisible) {
          document.getElementById('mye-ai-landing').classList.add('mye-hidden');
          document.getElementById('mye-ai-results-panel').classList.remove('mye-hidden');
          const scrollable = document.getElementById('mye-ai-results-scrollable');
          if (scrollable) scrollable.innerHTML = '';
        }
        
        appendUserMessage(text);
        
        if (isFromBottom) {
          if (bottomInput) { bottomInput.value = ''; bottomInput.focus(); }
        } else {
          if (landingInput) { landingInput.value = ''; }
        }

        // Bypass DM state machine if ULTRA mode is active (let LLM handle it)
        if (aiMode === 'ultra') {
          dmState = null;
          dmSelectedUser = null;
          await handleUltraQuery(text);
          return;
        }

        // ── DM Conversation State Machine ──
        const normText = normalizeStr(text);
        
        // Match: "envoyer/envoie/envoi un dm/message", "dm", "message", "dm à [nom]", "envoie un dm à [nom]"
        const dmPatterns = [
          /^(?:envoyer?|envoi[es]?)\s+(?:un\s+)?(?:dm|message)(?:\s+a\s+(.+))?$/i,
          /^dm(?:\s+a\s+(.+))?$/i,
          /^message(?:\s+a\s+(.+))?$/i
        ];
        let isDmTrigger = false;
        let dmAutoRecipient = null;
        for (const pat of dmPatterns) {
          const m = normText.match(pat);
          if (m) {
            isDmTrigger = true;
            if (m[1] && m[1].trim()) dmAutoRecipient = m[1].trim();
            break;
          }
        }

        // State: awaiting_recipient — user is typing a name to search
        if (dmState === 'awaiting_recipient') {
          showPortalLoading();
          try {
            const storage = await new Promise(resolve => {
              chrome.storage.local.get(['moodle_sesskey', 'moodle_userid'], resolve);
            });
            if (!storage || !storage.moodle_sesskey || !storage.moodle_userid) {
              appendBotMessage('❌ Session Moodle non configurée. Veuillez vous connecter à <a href="https://moodle.myefrei.fr" target="_blank" style="color:#4f46e5;font-weight:700;">Moodle</a> d\'abord.');
              dmState = null;
              return;
            }
            const users = await searchUsersCrossPlatform(text, storage.moodle_sesskey, parseInt(storage.moodle_userid, 10));
            if (users.length === 0) {
              appendBotMessage(`😕 Je n'ai trouvé aucun utilisateur Moodle correspondant à <strong>"${escapeHtml(text)}"</strong>.<br>Essayez un autre nom ou prénom.`);
              return; // stay in awaiting_recipient
            }
            // Show user list with clickable selection (max 3)
            let html = `<strong>Voici les utilisateurs trouvés :</strong><br><br>`;
            html += `<div style="display: flex; flex-direction: column; gap: 8px;">`;
            users.slice(0, 3).forEach(u => {
              const fullname = u.fullname || ((u.firstname || '') + ' ' + (u.lastname || '')).trim();
              if (!fullname) return;
              html += `<button class="mye-dm-select-user" data-userid="${u.id}" data-username="${escapeHtml(fullname)}" style="display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-radius: 12px; border: 1.5px solid #c7d2fe; background: white; cursor: pointer; text-align: left; font-family: inherit; font-size: 14px; transition: all 0.15s;">
                <span style="font-size: 20px;">👤</span>
                <span style="font-weight: 600; color: #1e293b;">${escapeHtml(fullname)}</span>
              </button>`;
            });
            html += `</div>`;
            html += `<br><div style="font-size: 12px; color: #64748b;">Cliquez sur un utilisateur pour le sélectionner, ou tapez un autre nom pour affiner.</div>`;
            appendBotMessage(html);

            // Attach click handlers on user buttons
            setTimeout(() => {
              document.querySelectorAll('.mye-dm-select-user').forEach(btn => {
                btn.addEventListener('click', () => {
                  const userId = btn.dataset.userid;
                  const userName = btn.dataset.username;
                  dmSelectedUser = { id: userId, name: userName };
                  dmState = 'awaiting_message';
                  appendBotMessage(`Vous avez sélectionné <strong>${escapeHtml(userName)}</strong>.<br><br>💬 Quel message souhaitez-vous lui envoyer ?`);
                  if (bottomInput) bottomInput.focus();
                });
              });
            }, 100);
          } catch (e) {
            appendBotMessage('❌ Erreur lors de la recherche d\'utilisateurs : ' + escapeHtml(e.message));
            dmState = null;
          }
          return;
        }

        // State: awaiting_message — user is typing a message to send
        if (dmState === 'awaiting_message' && dmSelectedUser) {
          showPortalLoading();
          try {
            await sendDmViaMoodle(dmSelectedUser.id, text);
            appendBotMessage(`✅ Message envoyé avec succès à <strong>${escapeHtml(dmSelectedUser.name)}</strong> !`);
          } catch (e) {
            appendBotMessage(`❌ Échec de l'envoi : ${escapeHtml(e.message)}`);
          }
          dmState = null;
          dmSelectedUser = null;
          return;
        }

        // Detect DM trigger from normal search
        if (isDmTrigger) {
          dmState = 'awaiting_recipient';
          dmSelectedUser = null;
          
          // If "DM à [nom]" was typed, auto-search the recipient immediately
          if (dmAutoRecipient) {
            appendBotMessage(`📨 <strong>Mode envoi de DM activé</strong><br><br>Recherche de "${escapeHtml(dmAutoRecipient)}"...`);
            // Re-run executeSearch with just the name, now in awaiting_recipient state
            await executeSearch(dmAutoRecipient, true);
          } else {
            appendBotMessage(`📨 <strong>Mode envoi de DM activé</strong><br><br>À qui souhaitez-vous envoyer un message ?<br>Tapez le nom de la personne.`);
          }
          if (bottomInput) bottomInput.focus();
          return;
        }

        // ── Normal search flow ──
        dmState = null;
        dmSelectedUser = null;

        showPortalLoading();

        try {
          const results = await searchMyEfreiAndMoodle(text);
          renderPortalResults(results, text);
          if (bottomInput) { bottomInput.focus(); }
        } catch(e) {
          renderPortalError(e.message);
        }
      };

      if (landingSubmit) landingSubmit.addEventListener('click', () => executeSearch(landingInput.value, false));
      if (landingInput) landingInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') executeSearch(landingInput.value, false); });

      if (bottomSubmit) bottomSubmit.addEventListener('click', () => executeSearch(bottomInput.value, true));
      if (bottomInput) bottomInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') executeSearch(bottomInput.value, true); });

      if (backBtn) {
        backBtn.addEventListener('click', () => {
          document.getElementById('mye-ai-results-panel').classList.add('mye-hidden');
          document.getElementById('mye-ai-landing').classList.remove('mye-hidden');
          if (landingInput) {
            landingInput.value = '';
            landingInput.focus();
          }
          if (bottomInput) {
            bottomInput.value = '';
          }
          lastSearchType = '';
          newsOffset = 0;
          ultraHistory = [];
        });
      }

      document.querySelectorAll('.mye-ai-link-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const query = btn.getAttribute('data-query');
          executeSearch(query, false);
        });
      });

      const scrollable = document.getElementById('mye-ai-results-scrollable');
      if (scrollable) {
        scrollable.addEventListener('click', async (e) => {
          const btn = e.target.closest('.mye-dm-trigger-btn');
          if (!btn) return;
          e.preventDefault();
          e.stopPropagation();
          
          btn.disabled = true;
          const originalContent = btn.innerHTML;
          btn.innerHTML = `<svg class="mye-spinner" viewBox="0 0 50 50" style="animation: mye-spin 1s linear infinite; width: 16px; height: 16px; display: inline-block; vertical-align: middle;"><circle cx="25" cy="25" r="20" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" style="stroke-dasharray: 80, 200; stroke-dashoffset: 0;"></circle></svg>`;
          
          try {
            let userId = btn.getAttribute('data-userid');
            const email = btn.getAttribute('data-email');
            const name = btn.getAttribute('data-name');
            
            const storage = await new Promise(resolve => {
              chrome.storage.local.get(['moodle_sesskey', 'moodle_userid'], resolve);
            });
            if (!storage || !storage.moodle_sesskey) {
              throw new Error("Session Moodle non connectée. Veuillez vous connecter sur Moodle d'abord.");
            }
            
            if (!userId) {
              const queryToSearch = email || name;
              if (!queryToSearch) throw new Error("Impossible de trouver les informations du contact.");
              
              const users = await searchUsersCrossPlatform(queryToSearch, storage.moodle_sesskey, parseInt(storage.moodle_userid, 10));
              if (users && users.length > 0) {
                const match = users.find(u => u.email && u.email.toLowerCase() === email.toLowerCase()) || users[0];
                userId = match.id;
              } else {
                throw new Error("Utilisateur introuvable sur Moodle.");
              }
            }
            
            const resultCard = btn.closest('.ia-result-card');
            if (resultCard) {
              const oldForm = document.querySelector('.mye-inline-dm-form');
              if (oldForm) oldForm.remove();
              
              const dmForm = document.createElement('div');
              dmForm.className = 'mye-inline-dm-form';
              dmForm.style.cssText = 'width: 100%; margin-top: 12px; padding: 12px; border-top: 1px solid rgba(0,0,0,0.05); display: flex; flex-direction: column; gap: 8px; box-sizing: border-box;';
              dmForm.innerHTML = `
                <textarea placeholder="Saisissez votre message direct..." style="width: 100%; min-height: 60px; padding: 8px 12px; border-radius: 8px; border: 1.5px solid #cbd5e1; outline: none; font-size: 14px; font-family: inherit; resize: vertical; box-sizing: border-box;" class="mye-inline-dm-textarea"></textarea>
                <div style="display: flex; gap: 8px; justify-content: flex-end;">
                  <button class="mye-inline-dm-cancel" style="background: transparent; border: none; padding: 6px 12px; font-size: 13px; font-weight: 600; color: #64748b; cursor: pointer;">Annuler</button>
                  <button class="mye-inline-dm-send" style="background: #ef4444; border: none; border-radius: 6px; padding: 6px 16px; font-size: 13px; font-weight: 600; color: white; cursor: pointer; display: flex; align-items: center; gap: 4px;">Envoyer</button>
                </div>
              `;
              
              resultCard.appendChild(dmForm);
              const textarea = dmForm.querySelector('.mye-inline-dm-textarea');
              if (textarea) textarea.focus();
              
              dmForm.querySelector('.mye-inline-dm-cancel').addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                dmForm.remove();
              });
              
              dmForm.querySelector('.mye-inline-dm-send').addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                const text = textarea.value.trim();
                if (!text) return;
                
                const sendBtn = e.target.closest('.mye-inline-dm-send');
                sendBtn.disabled = true;
                sendBtn.innerHTML = 'Envoi...';
                
                try {
                  let sent = false;
                  // Try to send via conversation id or get conversation between users first
                  try {
                    const conv = await callMoodleAjaxCrossPlatform('core_message_get_conversation_between_users', {
                      userid: parseInt(storage.moodle_userid, 10),
                      otheruserid: parseInt(userId, 10),
                      includecontactrequests: true,
                      includeprivacyinfo: true
                    }, storage.moodle_sesskey, parseInt(storage.moodle_userid, 10));
                    
                    if (conv && conv.id) {
                      await callMoodleAjaxCrossPlatform('core_message_send_messages_to_conversation', {
                        conversationid: conv.id,
                        messages: [
                          {
                            text: text,
                            textformat: 1
                          }
                        ]
                      }, storage.moodle_sesskey, parseInt(storage.moodle_userid, 10));
                      sent = true;
                    }
                  } catch (convErr) {
                    console.log('[IA DM] Failed with conversation endpoints, trying legacy instant messages...', convErr);
                  }
                  
                  if (!sent) {
                    // Fallback to legacy core_message_send_instant_messages
                    await callMoodleAjaxCrossPlatform('core_message_send_instant_messages', {
                      messages: [
                        {
                          touserid: parseInt(userId, 10),
                          text: text,
                          textformat: 1 // HTML
                        }
                      ]
                    }, storage.moodle_sesskey, parseInt(storage.moodle_userid, 10));
                  }
                  
                  dmForm.innerHTML = `<div style="color: #10b981; font-weight: 600; font-size: 13.5px; display: flex; align-items: center; gap: 6px; padding: 4px 0;"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block; vertical-align: middle;"><polyline points="20 6 9 17 4 12"></polyline></svg> Message envoyé avec succès !</div>`;
                  setTimeout(() => dmForm.remove(), 2500);
                } catch (err) {
                  console.error('[IA DM] Failed to send:', err);
                  alert("Erreur lors de l'envoi : " + err.message);
                  sendBtn.disabled = false;
                  sendBtn.innerHTML = 'Envoyer';
                }
              });
            }
          } catch (err) {
            console.error('[IA DM] Resolve user failed:', err);
            alert("Erreur : " + err.message);
          } finally {
            btn.innerHTML = originalContent;
            btn.disabled = false;
          }
        });
      }
    };

    const escapeHtml = (unsafe) => {
      return unsafe
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
    };

    const appendUserMessage = (text) => {
      const scrollable = document.getElementById('mye-ai-results-scrollable');
      if (scrollable) {
        const userRow = document.createElement('div');
        userRow.className = 'mye-chat-row-user';
        userRow.innerHTML = `
          <div class="mye-chat-bubble-user">
            ${escapeHtml(text)}
          </div>
        `;
        scrollable.appendChild(userRow);
        scrollable.scrollTop = scrollable.scrollHeight;
      }
    };

    const showPortalLoading = () => {
      const scrollable = document.getElementById('mye-ai-results-scrollable');
      if (scrollable) {
        const oldTemp = document.getElementById('mye-chat-loading-temp');
        if (oldTemp) oldTemp.remove();

        const loadingRow = document.createElement('div');
        loadingRow.className = 'mye-chat-row-bot';
        loadingRow.id = 'mye-chat-loading-temp';
        loadingRow.innerHTML = `
          <div class="mye-chat-bot-header">
            <span class="mye-chat-bot-avatar">
              <img src="${myhubLogoUrl}" class="mye-chat-bot-avatar-img" alt="myHub">
            </span>
            <span class="mye-chat-bot-name">Assistant IA</span>
          </div>
          <div class="mye-chat-bot-content">
            <div class="mye-gemini-loader">
              <div class="mye-gemini-orb"></div>
              <div class="mye-gemini-orb"></div>
              <div class="mye-gemini-orb"></div>
            </div>
          </div>
        `;
        scrollable.appendChild(loadingRow);
        scrollable.scrollTop = scrollable.scrollHeight;
      }
    };

    const renderPortalResults = (results, query) => {
      const scrollable = document.getElementById('mye-ai-results-scrollable');
      if (scrollable) {
        const tempLoading = document.getElementById('mye-chat-loading-temp');
        if (tempLoading) tempLoading.remove();

        const botHtml = myeRenderResults(results, query);
        const botRow = document.createElement('div');
        botRow.className = 'mye-chat-row-bot';
        botRow.innerHTML = `
          <div class="mye-chat-bot-header">
            <span class="mye-chat-bot-avatar">
              <img src="${myhubLogoUrl}" class="mye-chat-bot-avatar-img" alt="myHub">
            </span>
            <span class="mye-chat-bot-name">Assistant IA</span>
          </div>
          <div class="mye-chat-bot-content">
            ${botHtml}
          </div>
        `;
        scrollable.appendChild(botRow);
        
        scrollable.scrollTop = scrollable.scrollHeight;
        requestAnimationFrame(() => {
          scrollable.scrollTop = scrollable.scrollHeight;
        });
      }
    };

    const renderPortalError = (msg) => {
      const scrollable = document.getElementById('mye-ai-results-scrollable');
      if (scrollable) {
        const tempLoading = document.getElementById('mye-chat-loading-temp');
        if (tempLoading) tempLoading.remove();

        const botRow = document.createElement('div');
        botRow.className = 'mye-chat-row-bot';
        botRow.innerHTML = `
          <div class="mye-chat-bot-header">
            <span class="mye-chat-bot-avatar">
              <img src="${myhubLogoUrl}" class="mye-chat-bot-avatar-img" alt="myHub">
            </span>
            <span class="mye-chat-bot-name">Assistant IA</span>
          </div>
          <div class="mye-chat-bot-content">
            <div style="padding: 20px; text-align: center; color: #ef4444; font-weight: 600; background: rgba(239, 68, 68, 0.05); border-radius: 16px; border: 1px solid rgba(239, 68, 68, 0.1);">
              ❌ Une erreur est survenue : <em>${msg}</em>
            </div>
          </div>
        `;
        scrollable.appendChild(botRow);
        scrollable.scrollTop = scrollable.scrollHeight;
      }
    };

    // Helper to append a bot text message (for DM conversation flow)
    const appendBotMessage = (html) => {
      const scrollable = document.getElementById('mye-ai-results-scrollable');
      if (scrollable) {
        const tempLoading = document.getElementById('mye-chat-loading-temp');
        if (tempLoading) tempLoading.remove();

        const botRow = document.createElement('div');
        botRow.className = 'mye-chat-row-bot';
        botRow.innerHTML = `
          <div class="mye-chat-bot-header">
            <span class="mye-chat-bot-avatar">
              <img src="${myhubLogoUrl}" class="mye-chat-bot-avatar-img" alt="myHub">
            </span>
            <span class="mye-chat-bot-name">Assistant IA</span>
          </div>
          <div class="mye-chat-bot-content">
            <div style="padding: 16px 20px; background: linear-gradient(135deg, #eef2ff 0%, #e0e7ff 100%); border: 1.5px solid #c7d2fe; border-radius: 20px; font-family: 'Outfit', sans-serif; font-size: 15px; color: #1e293b; line-height: 1.6; font-weight: 500;">
              ${html}
            </div>
          </div>
        `;
        scrollable.appendChild(botRow);
        scrollable.scrollTop = scrollable.scrollHeight;
        requestAnimationFrame(() => { scrollable.scrollTop = scrollable.scrollHeight; });
      }
    };

    // Send DM via Moodle API
    const sendDmViaMoodle = async (targetUserId, messageText) => {
      const storage = await new Promise(resolve => {
        chrome.storage.local.get(['moodle_sesskey', 'moodle_userid'], resolve);
      });
      if (!storage || !storage.moodle_sesskey || !storage.moodle_userid) {
        throw new Error('Session Moodle non configurée. Veuillez vous connecter à Moodle.');
      }
      const sesskey = storage.moodle_sesskey;
      const myUserId = parseInt(storage.moodle_userid, 10);

      let sent = false;
      // Try conversation API first
      try {
        const conv = await callMoodleAjaxCrossPlatform('core_message_get_conversation_between_users', {
          userid: myUserId,
          otheruserid: parseInt(targetUserId, 10),
          includecontactrequests: true,
          includeprivacyinfo: true
        }, sesskey, myUserId);
        
        if (conv && conv.id) {
          await callMoodleAjaxCrossPlatform('core_message_send_messages_to_conversation', {
            conversationid: conv.id,
            messages: [{ text: messageText, textformat: 1 }]
          }, sesskey, myUserId);
          sent = true;
        }
      } catch (e) {
        console.log('[IA DM] Conversation API failed, trying legacy...', e);
      }
      
      if (!sent) {
        await callMoodleAjaxCrossPlatform('core_message_send_instant_messages', {
          messages: [{ touserid: parseInt(targetUserId, 10), text: messageText, textformat: 1 }]
        }, sesskey, myUserId);
      }
    };

    // ═══════════════════════════════════════════
    // ULTRA MODE — Multi-provider LLM Integration
    // ═══════════════════════════════════════════

    // Simple markdown-to-HTML parser
    const parseMarkdownToHtml = (md) => {
      if (!md) return '';
      let html = md;

      // Escape HTML tags to prevent arbitrary HTML injection (allowing bold/italics etc in next steps)
      html = html.replace(/&/g, '&amp;')
                 .replace(/</g, '&lt;')
                 .replace(/>/g, '&gt;');

      // Code blocks: ```code```
      html = html.replace(/```([\s\S]*?)```/g, '<pre style="background: rgba(0,0,0,0.05); padding: 10px; border-radius: 8px; font-family: monospace; font-size: 13px; overflow-x: auto; margin: 10px 0;">$1</pre>');

      // Inline code: `code`
      html = html.replace(/`(.*?)`/g, '<code style="background: rgba(0,0,0,0.05); padding: 2px 6px; border-radius: 4px; font-family: monospace; font-size: 13px;">$1</code>');

      // Bold: **text** or __text__
      html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
      html = html.replace(/__(.*?)__/g, '<strong>$1</strong>');

      // Italics: *text* or _text_
      html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
      html = html.replace(/_(.*?)_/g, '<em>$1</em>');

      // Split lines to construct paragraphs and lists
      const lines = html.split('\n');
      let inList = false;
      const parsedLines = lines.map(line => {
        const trimmed = line.trim();
        if (trimmed.startsWith('* ') || trimmed.startsWith('- ')) {
          const content = trimmed.substring(2);
          let prefix = '';
          if (!inList) {
            inList = true;
            prefix = '<ul style="margin: 8px 0; padding-left: 20px; display: flex; flex-direction: column; gap: 6px; list-style-type: disc;">';
          }
          return prefix + `<li>${content}</li>`;
        } else {
          let suffix = '';
          if (inList) {
            inList = false;
            suffix = '</ul>';
          }
          return suffix + (trimmed ? `<p style="margin: 8px 0;">${trimmed}</p>` : '');
        }
      });
      if (inList) {
        parsedLines.push('</ul>');
      }

      return parsedLines.join('');
    };

    const LLM_PROVIDERS = {
      gemini: {
        name: 'Gemini',
        model: 'gemini-2.0-flash',
        buildRequest: (messages, apiKey) => {
          const systemMsg = messages.find(m => m.role === 'system');
          const userMsgs = messages.filter(m => m.role !== 'system');
          const contents = userMsgs.map(m => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }]
          }));
          return {
            url: `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
            options: {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                system_instruction: systemMsg ? { parts: [{ text: systemMsg.content }] } : undefined,
                contents,
                generationConfig: { temperature: 0.7, maxOutputTokens: 4096 }
              })
            }
          };
        },
        parseResponse: (data) => {
          if (data.candidates && data.candidates[0] && data.candidates[0].content) {
            return data.candidates[0].content.parts.map(p => p.text).join('');
          }
          if (data.error) throw new Error(data.error.message || 'Gemini API error');
          throw new Error('Unexpected Gemini response format');
        }
      },
      openai: {
        name: 'ChatGPT',
        model: 'gpt-4o-mini',
        buildRequest: (messages, apiKey) => ({
          url: 'https://api.openai.com/v1/chat/completions',
          options: {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify({ model: 'gpt-4o-mini', messages, temperature: 0.7, max_tokens: 4096 })
          }
        }),
        parseResponse: (data) => {
          if (data.choices && data.choices[0]) return data.choices[0].message.content;
          if (data.error) throw new Error(data.error.message || 'OpenAI API error');
          throw new Error('Unexpected OpenAI response format');
        }
      },
      claude: {
        name: 'Claude',
        model: 'claude-sonnet-4-20250514',
        buildRequest: (messages, apiKey) => {
          const systemMsg = messages.find(m => m.role === 'system');
          const chatMsgs = messages.filter(m => m.role !== 'system');
          return {
            url: 'https://api.anthropic.com/v1/messages',
            options: {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
                'anthropic-dangerous-direct-browser-access': 'true'
              },
              body: JSON.stringify({
                model: 'claude-sonnet-4-20250514',
                max_tokens: 4096,
                system: systemMsg ? systemMsg.content : undefined,
                messages: chatMsgs
              })
            }
          };
        },
        parseResponse: (data) => {
          if (data.content && data.content[0]) return data.content[0].text;
          if (data.error) throw new Error(data.error.message || 'Claude API error');
          throw new Error('Unexpected Claude response format');
        }
      },
      grok: {
        name: 'Grok',
        model: 'grok-3-mini',
        buildRequest: (messages, apiKey) => ({
          url: 'https://api.x.ai/v1/chat/completions',
          options: {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify({ model: 'grok-3-mini', messages, temperature: 0.7, max_tokens: 4096 })
          }
        }),
        parseResponse: (data) => {
          if (data.choices && data.choices[0]) return data.choices[0].message.content;
          if (data.error) throw new Error(data.error.message || 'Grok API error');
          throw new Error('Unexpected Grok response format');
        }
      },
      groq: {
        name: 'Groq',
        model: 'llama-3.3-70b-versatile',
        buildRequest: (messages, apiKey) => ({
          url: 'https://api.groq.com/openai/v1/chat/completions',
          options: {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages, temperature: 0.7, max_tokens: 4096 })
          }
        }),
        parseResponse: (data) => {
          if (data.choices && data.choices[0]) return data.choices[0].message.content;
          if (data.error) throw new Error(data.error.message || 'Groq API error');
          throw new Error('Unexpected Groq response format');
        }
      },
      mistral: {
        name: 'Mistral',
        model: 'mistral-large-latest',
        buildRequest: (messages, apiKey) => ({
          url: 'https://api.mistral.ai/v1/chat/completions',
          options: {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify({ model: 'mistral-large-latest', messages, temperature: 0.7, max_tokens: 4096 })
          }
        }),
        parseResponse: (data) => {
          if (data.choices && data.choices[0]) return data.choices[0].message.content;
          if (data.error) throw new Error(data.error.message || 'Mistral API error');
          throw new Error('Unexpected Mistral response format');
        }
      },
      qwen: {
        name: 'Qwen',
        model: 'qwen-max',
        buildRequest: (messages, apiKey) => ({
          url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
          options: {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify({ model: 'qwen-max', messages, temperature: 0.7, max_tokens: 4096 })
          }
        }),
        parseResponse: (data) => {
          if (data.choices && data.choices[0]) return data.choices[0].message.content;
          if (data.error) throw new Error(data.error.message || 'Qwen API error');
          throw new Error('Unexpected Qwen response format');
        }
      },
      deepseek: {
        name: 'DeepSeek',
        model: 'deepseek-chat',
        buildRequest: (messages, apiKey) => ({
          url: 'https://api.deepseek.com/chat/completions',
          options: {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify({ model: 'deepseek-chat', messages, temperature: 0.7, max_tokens: 4096 })
          }
        }),
        parseResponse: (data) => {
          if (data.choices && data.choices[0]) return data.choices[0].message.content;
          if (data.error) throw new Error(data.error.message || 'DeepSeek API error');
          throw new Error('Unexpected DeepSeek response format');
        }
      },
      openrouter: {
        name: 'OpenRouter',
        model: 'google/gemini-2.5-flash',
        buildRequest: (messages, apiKey) => ({
          url: 'https://openrouter.ai/api/v1/chat/completions',
          options: {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${apiKey}`,
              'HTTP-Referer': 'https://myhub.efrei.fr',
              'X-Title': 'myHub ULTRA'
            },
            body: JSON.stringify({ model: 'google/gemini-2.5-flash', messages, temperature: 0.7, max_tokens: 4096 })
          }
        }),
        parseResponse: (data) => {
          if (data.choices && data.choices[0]) return data.choices[0].message.content;
          if (data.error) throw new Error(data.error.message || (data.error.metadata && data.error.metadata.raw) || 'OpenRouter API error');
          throw new Error('Unexpected OpenRouter response format');
        }
      }
    };

    // Unified LLM caller
    const callLLM = async (messages) => {
      if (!aiApiKey) throw new Error('Clé API manquante. Configurez votre clé dans la barre latérale.');
      const provider = LLM_PROVIDERS[aiProvider];
      if (!provider) throw new Error(`Provider inconnu : ${aiProvider}`);
      
      const { url, options } = provider.buildRequest(messages, aiApiKey);
      const res = await fetch(url, options);
      const data = await res.json();
      return provider.parseResponse(data);
    };

    // Build context from all cached data for the LLM
    // Execute API requests made by the ULTRA mode LLM
    const executeUltraApiCall = async (apiName, params = {}) => {
      const getMoodleCredentials = async () => {
        return new Promise(resolve => {
          chrome.storage.local.get(['moodle_sesskey', 'moodle_userid'], resolve);
        });
      };

      try {
        switch (apiName) {
          case 'get_news':
            return myefreiCache.news.slice(0, 15).map(n => ({
              titre: n.title || n.name || '',
              resume: n.head || n.content || n.summary || '',
              date: n.publicationDate || n.date || n.createdAt || ''
            }));
          case 'get_grades':
            return myefreiCache.grades.map(g => {
              const ues = g.data && (g.data.ues || (Array.isArray(g.data) ? g.data : (g.data.grades && g.data.grades.ues))) || [];
              const listMatieres = [];
              ues.forEach(ue => {
                const subjects = ue.modules || ue.subjects || ue.courses || [];
                if (Array.isArray(subjects) && subjects.length > 0) {
                  subjects.forEach(sub => {
                    listMatieres.push({
                      matiere: sub.name || sub.subject || sub.courseName || '',
                      note: sub.grade !== undefined && sub.grade !== null ? sub.grade : (sub.average !== undefined && sub.average !== null ? sub.average : ''),
                      coeff: sub.coef !== undefined && sub.coef !== null ? sub.coef : (sub.coefficient !== undefined ? sub.coefficient : ''),
                      ue: ue.name || ''
                    });
                  });
                } else {
                  listMatieres.push({
                    matiere: ue.name || '',
                    note: ue.grade !== undefined && ue.grade !== null ? ue.grade : (ue.average !== undefined && ue.average !== null ? ue.average : ''),
                    coeff: ue.coef !== undefined && ue.coef !== null ? ue.coef : (ue.ectsAttempted !== undefined ? ue.ectsAttempted : ''),
                    ue: ue.name || ''
                  });
                }
              });

              return {
                periode: g.period,
                annee: g.schoolYear,
                matieres: listMatieres
              };
            });
          case 'get_absences':
            return myefreiCache.absences.map(a => {
              const justified = a.justified === true || a.status === 'excused' || a.status === 'justified';
              const isRetard = a.type === 'lateness' || a.type === 'late' || (a.label && a.label.toLowerCase().includes('retard'));
              return {
                date: a.startDateTime || a.date || a.startDate || '',
                type: isRetard ? 'retard' : 'absence',
                matiere: a.subjectName || a.courseName || a.subject || a.name || '',
                statut: justified ? 'justifié' : 'non justifié'
              };
            });
          case 'get_resources':
            return myefreiCache.resources.map(r => ({
              categorie: r.category,
              groupes: (r.groups || []).map(g => ({
                nom: g.name,
                documents: (g.items || []).map(i => i.title || i.name || '')
              }))
            }));
          case 'get_contacts':
            return myefreiCache.contacts.map(c => ({
              nom: [c.firstName, c.lastName].filter(Boolean).join(' ') || c.name || '',
              email: c.email || '',
              role: c.role || c.function || '',
              telephone: c.phone || ''
            }));
          case 'get_documents':
            return myefreiCache.documents.map(d => ({
              titre: d.title || d.name || '',
              type: d.source || ''
            }));
          case 'get_courses': {
            const m = await getMoodleCredentials();
            if (!m || !m.moodle_sesskey) return { error: 'Non connecté à Moodle' };
            const courses = await getMyCoursesCrossPlatform(m.moodle_sesskey, parseInt(m.moodle_userid, 10));
            return courses.map(c => ({ id: c.id, nom: c.fullname || c.shortname || '' }));
          }
          case 'get_calendar_events': {
            const m = await getMoodleCredentials();
            if (!m || !m.moodle_sesskey) return { error: 'Non connecté à Moodle' };
            const events = await getCalendarEventsCrossPlatform(m.moodle_sesskey, parseInt(m.moodle_userid, 10));
            return events.map(e => ({ nom: e.name, description: e.description, fin: e.timesort, cours: e.course ? e.course.fullname : '' }));
          }
          case 'search_moodle': {
            const q = params.query || '';
            if (!q) return { error: 'Paramètre "query" manquant' };
            const m = await getMoodleCredentials();
            if (!m || !m.moodle_sesskey) return { error: 'Non connecté à Moodle' };
            const results = await searchMoodleContentCrossPlatform(q, m.moodle_sesskey, parseInt(m.moodle_userid, 10));
            return results.map(r => ({ titre: r.title, description: r.description, url: r.url }));
          }
          case 'search_users': {
            const q = params.query || '';
            if (!q) return { error: 'Paramètre "query" manquant' };
            const m = await getMoodleCredentials();
            if (!m || !m.moodle_sesskey) return { error: 'Non connecté à Moodle' };
            const users = await searchUsersCrossPlatform(q, m.moodle_sesskey, parseInt(m.moodle_userid, 10));
            return users.map(u => ({ id: u.id, nom: u.fullname || ((u.firstname || '') + ' ' + (u.lastname || '')).trim() }));
          }
          case 'send_message': {
            const userId = params.userId || '';
            const text = params.text || '';
            if (!userId) return { error: 'Paramètre "userId" manquant' };
            if (!text) return { error: 'Paramètre "text" manquant' };
            await sendDmViaMoodle(userId, text);
            return { success: true, message: `Message envoyé avec succès` };
          }
          default:
            return { error: `API inconnue : ${apiName}` };
        }
      } catch (err) {
        return { error: `Erreur d'exécution : ${err.message}` };
      }
    };

    // Handle ULTRA mode query using an agentic loop (ReAct)
    const handleUltraQuery = async (text) => {
      if (!aiApiKey) {
        appendBotMessage('🔑 <strong>Clé API requise</strong><br><br>Pour utiliser le mode ULTRA, configurez votre clé API dans la barre latérale.<br>Sélectionnez votre provider (Gemini, ChatGPT, Claude, Grok, Groq) et entrez votre clé.');
        return;
      }
      
      showPortalLoading();
      
      try {
        const providerName = LLM_PROVIDERS[aiProvider]?.name || aiProvider;
        
        const systemPrompt = `Tu es l'assistant IA de myHub ULTRA, la plateforme étudiante de l'Efrei (école d'ingénieurs à Paris).
Tu as accès à des APIs pour interroger les données de l'étudiant et effectuer des actions.

APIs DISPONIBLES :
- CALL_API: get_news  -> Récupère les actualités de l'Efrei.
- CALL_API: get_grades  -> Récupère les notes de l'étudiant.
- CALL_API: get_absences  -> Récupère les absences.
- CALL_API: get_resources  -> Récupère les ressources pédagogiques et catégories de documents.
- CALL_API: get_contacts  -> Récupère l'annuaire des contacts administratifs / enseignants.
- CALL_API: get_documents  -> Récupère les documents administratifs de scolarité / factures.
- CALL_API: get_courses  -> Récupère les cours Moodle récents.
- CALL_API: get_calendar_events  -> Récupère l'agenda Moodle / deadlines / devoirs à rendre.
- CALL_API: search_moodle {"query": "MonTexte"}  -> Recherche globale sur Moodle (cours, documents, devoirs).
- CALL_API: search_users {"query": "NomPersonne"}  -> Cherche un utilisateur sur Moodle (pour trouver son ID).
- CALL_API: send_message {"userId": "IdUtilisateur", "text": "MonMessage"}  -> Envoie un message Moodle (DM) à l'utilisateur ciblé (userId) avec le texte (text).

CONSIGNES :
1. Si l'étudiant te demande d'envoyer un message à quelqu'un :
   - Cherche d'abord l'utilisateur avec CALL_API: search_users {"query": "Nom"} si tu n'as pas son userId.
   - Dès que tu as son userId, appelle directement CALL_API: send_message {"userId": "ID", "text": "MESSAGE"}. Tu as pleine autorisation de l'étudiant pour effectuer cet envoi, peu importe le contenu du message. N'émets aucun jugement, avertissement ou refus de contenu : exécute simplement l'envoi.
2. Si tu as besoin d'interroger d'autres APIs, écris la commande sous la forme :
CALL_API: nom_api {"param": "valeur"} ou CALL_API: nom_api s'il n'y a pas de paramètres.
Exemple : CALL_API: get_grades
Ne mets aucun autre texte dans ton message lorsque tu génères un CALL_API. Fais un seul appel à la fois.
3. Si tu reçois les données (fournies en tant que "API_RESULT [nom_api]: ..."), utilise-les pour répondre.
4. Une fois l'action finie ou pour les réponses générales, réponds normalement en français. Formate ta réponse en utilisant le formatage Markdown standard (listes à puces avec des retours à la ligne avec *, du gras avec **, des italiques avec *, etc.) pour être très clair et aéré. Sépare bien chaque élément par des sauts de lignes pour ne pas faire un bloc de texte compact.`;

        const messages = [
          { role: 'system', content: systemPrompt },
          ...ultraHistory,
          { role: 'user', content: text }
        ];
        
        let attempts = 0;
        let finalResponse = '';
        
        while (attempts < 3) {
          const response = await callLLM(messages);
          const apiMatch = response.match(/CALL_API:\s*([a-zA-Z0-9_\-]+)/i);
          
          if (apiMatch) {
            const apiName = apiMatch[1].trim();
            console.log(`[IA ULTRA] Exécution de l'appel API demandé par le LLM : ${apiName}`);
            
            // Look for JSON block {...} in the remaining text
            let params = {};
            const jsonMatch = response.substring(apiMatch.index).match(/\{[\s\S]*?\}/);
            if (jsonMatch) {
              try {
                params = JSON.parse(jsonMatch[0]);
              } catch (e) {
                console.warn(`[IA ULTRA] Failed to parse JSON parameters for ${apiName}:`, e);
              }
            }
            
            const result = await executeUltraApiCall(apiName, params);
            
            // Append assistant command and API results to the conversation history
            messages.push({ role: 'assistant', content: response });
            messages.push({ role: 'user', content: `API_RESULT [${apiName}]: ${JSON.stringify(result)}` });
            attempts++;
          } else {
            finalResponse = response;
            break;
          }
        }
        
        if (!finalResponse) {
          finalResponse = "Désolé, j'ai rencontré un problème lors de la récupération des données de l'API.";
        }
        
        // Render the LLM response
        const scrollable = document.getElementById('mye-ai-results-scrollable');
        if (scrollable) {
          const tempLoading = document.getElementById('mye-chat-loading-temp');
          if (tempLoading) tempLoading.remove();
          
          const botRow = document.createElement('div');
          botRow.className = 'mye-chat-row-bot';
          botRow.innerHTML = `
            <div class="mye-chat-bot-header">
              <span class="mye-chat-bot-avatar">
                <img src="${myhubLogoUrl}" class="mye-chat-bot-avatar-img" alt="myHub">
              </span>
              <span class="mye-chat-bot-name">Assistant IA <span style="font-size: 10px; background: linear-gradient(135deg, #6366f1, #8b5cf6); color: white; padding: 2px 8px; border-radius: 10px; margin-left: 6px; font-weight: 700;">ULTRA · ${escapeHtml(providerName)}</span></span>
            </div>
            <div class="mye-chat-bot-content">
              <div class="mye-ultra-response-formatted" style="padding: 18px 22px; background: linear-gradient(135deg, #f0f0ff 0%, #e8e0ff 50%, #f0e8ff 100%); border: 1.5px solid #c4b5fd; border-radius: 20px; font-family: 'Outfit', sans-serif; font-size: 15px; color: #1e293b; line-height: 1.7; display: flex; flex-direction: column; gap: 8px;">
                ${parseMarkdownToHtml(finalResponse)}
              </div>
            </div>
          `;
          scrollable.appendChild(botRow);
          scrollable.scrollTop = scrollable.scrollHeight;
          requestAnimationFrame(() => { scrollable.scrollTop = scrollable.scrollHeight; });
        }

        // Save to conversational history
        ultraHistory.push({ role: 'user', content: text });
        ultraHistory.push({ role: 'assistant', content: finalResponse });
        if (ultraHistory.length > 20) {
          ultraHistory = ultraHistory.slice(-20);
        }
      } catch (e) {
        appendBotMessage(`❌ <strong>Erreur ${LLM_PROVIDERS[aiProvider]?.name || aiProvider}</strong><br><br>${escapeHtml(e.message)}`);
      }
    };

    // Inject the main portal chat layout
    const injectPortalChatUI = () => {
      if (document.getElementById('mye-ai-container')) return;

      const container = document.createElement('div');
      container.id = 'mye-ai-container';
      container.className = 'mye-page-container';
      
      const logoUrl = chrome.runtime.getURL('img/logoMyHub.png');
      const myefreiLogoUrl = chrome.runtime.getURL('img/logomyEfreiUltra.png');
      const moodleLogoUrl = chrome.runtime.getURL('img/logoMyMoodleUltra.png');
      const messageLogoUrl = chrome.runtime.getURL('img/Message.png');

      container.innerHTML = `
        <div class="mye-ai-main-layout">
          <div class="mye-ai-left-sidebar">
            <div class="mye-ai-brand-card">
              <img src="${logoUrl}" class="mye-ai-brand-logo" alt="myHub logo">
              <span class="mye-ai-brand-name">myHub ULTRA</span>
            </div>
            
            <!-- Mode Toggle: Simple / ULTRA -->
            <div class="mye-mode-toggle-card">
              <div class="mye-segmented-control">
                <button id="mye-mode-simple" class="mye-mode-btn ${aiMode === 'simple' ? 'mye-mode-active-simple' : ''}">
                  ⚡ Simple
                </button>
                <button id="mye-mode-ultra" class="mye-mode-btn ${aiMode === 'ultra' ? 'mye-mode-active-ultra' : ''}">
                  ★ ULTRA
                </button>
              </div>
              
              <!-- ULTRA config panel -->
              <div id="mye-ultra-config" style="display: ${aiMode === 'ultra' ? 'block' : 'none'};">
                <label class="mye-ultra-label">Provider IA</label>
                <select id="mye-ai-provider" class="mye-ultra-select">
                  <option value="gemini" ${aiProvider === 'gemini' ? 'selected' : ''}>🔵 Gemini</option>
                  <option value="openai" ${aiProvider === 'openai' ? 'selected' : ''}>🟢 ChatGPT</option>
                  <option value="claude" ${aiProvider === 'claude' ? 'selected' : ''}>🟠 Claude</option>
                  <option value="grok" ${aiProvider === 'grok' ? 'selected' : ''}>⚫ Grok</option>
                  <option value="groq" ${aiProvider === 'groq' ? 'selected' : ''}>🔴 Groq</option>
                  <option value="mistral" ${aiProvider === 'mistral' ? 'selected' : ''}>🟠 Mistral</option>
                  <option value="qwen" ${aiProvider === 'qwen' ? 'selected' : ''}>🟣 Qwen</option>
                  <option value="deepseek" ${aiProvider === 'deepseek' ? 'selected' : ''}>🔵 DeepSeek</option>
                  <option value="openrouter" ${aiProvider === 'openrouter' ? 'selected' : ''}>🪐 OpenRouter</option>
                </select>
                
                <label class="mye-ultra-label" style="margin-top: 10px !important;">Clé API</label>
                <div class="mye-ultra-input-container">
                  <input type="password" id="mye-ai-apikey" class="mye-ultra-input" placeholder="sk-..." value="${escapeHtml(aiApiKey)}">
                  <button id="mye-ai-toggle-key" class="mye-ultra-toggle-key" title="Afficher/masquer">👁</button>
                </div>
                <div id="mye-ai-key-status" class="mye-ultra-key-status" style="color: ${aiApiKey ? '#059669' : '#94a3b8'};">
                  ${aiApiKey ? '✓ Clé sauvegardée' : 'Entrez votre clé API'}
                </div>
              </div>
            </div>

            <div class="mye-focus-cards">
              <!-- Focus myEfrei -->
              <div class="mye-focus-card mye-focus-myefrei">
                <div class="mye-focus-icon-circle">
                  <img src="${myefreiLogoUrl}" class="mye-focus-icon-img" alt="myEfrei">
                </div>
                <div class="mye-focus-card-body">
                  <span class="mye-focus-title">Focus myEfrei</span>
                  <label class="mye-ai-switch">
                    <input type="checkbox" id="mye-toggle-myefrei" ${focusSettings.myefrei ? 'checked' : ''}>
                    <span class="mye-ai-slider"></span>
                  </label>
                </div>
              </div>

              <!-- Focus Moodle -->
              <div class="mye-focus-card mye-focus-moodle">
                <div class="mye-focus-icon-circle">
                  <img src="${moodleLogoUrl}" class="mye-focus-icon-img" alt="Moodle">
                </div>
                <div class="mye-focus-card-body">
                  <span class="mye-focus-title">Focus Moodle</span>
                  <label class="mye-ai-switch">
                    <input type="checkbox" id="mye-toggle-moodle" ${focusSettings.moodle ? 'checked' : ''}>
                    <span class="mye-ai-slider"></span>
                  </label>
                </div>
              </div>

              <!-- Focus Message -->
              <div class="mye-focus-card mye-focus-message">
                <div class="mye-focus-icon-circle">
                  <img src="${messageLogoUrl}" class="mye-focus-icon-img" alt="Message">
                </div>
                <div class="mye-focus-card-body">
                  <span class="mye-focus-title">Focus Message</span>
                  <label class="mye-ai-switch">
                    <input type="checkbox" id="mye-toggle-message" ${focusSettings.message ? 'checked' : ''}>
                    <span class="mye-ai-slider"></span>
                  </label>
                </div>
              </div>
            </div>
            
            <button id="mye-ai-exit-btn" class="mye-ai-exit-btn">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
              <span>Retour sur myEfrei</span>
            </button>
          </div>

          <div class="mye-ai-right-content">
            <div class="mye-ai-center-view">
              <div class="mye-ai-landing" id="mye-ai-landing">
                <h1 class="mye-ai-landing-title">BONJOUR</h1>
                <h2 class="mye-ai-landing-subtitle">Que cherchez vous ?</h2>
                
                <div class="mye-ai-search-box">
                  <input type="text" id="mye-ai-search-input-landing" placeholder="Chercher dans l'univers de l'Efrei">
                  <button id="mye-ai-search-submit-landing" title="Rechercher">
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                  </button>
                </div>

                <div class="mye-ai-quick-links">
                  <button class="mye-ai-link-btn" data-query="actualités">Actualité</button>
                  <button class="mye-ai-link-btn" data-query="deadlines">Mes deadlines</button>
                  <button class="mye-ai-link-btn" data-query="envoyer un DM">Envoyer un DM</button>
                </div>
              </div>

              <!-- Dynamic search results viewport -->
              <div class="mye-ai-results-panel mye-hidden" id="mye-ai-results-panel">
                <div class="mye-ai-results-header-row">
                  <button id="mye-ai-back-btn" class="mye-ai-back-btn" title="Retour à l'accueil">
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
                    <span>Retour</span>
                  </button>
                </div>
                <div class="mye-ai-results-scrollable" id="mye-ai-results-scrollable">
                  <!-- Result cards rendered here -->
                </div>
                <!-- ChatGPT style Bottom search input -->
                <div class="mye-ai-bottom-container">
                  <div class="mye-ai-search-box">
                    <input type="text" id="mye-ai-search-input-bottom" placeholder="Poser une autre question...">
                    <button id="mye-ai-search-submit-bottom" title="Rechercher">
                      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      `;

      document.body.appendChild(container);

      attachPortalChatEvents();

      if (focusSettings.myefrei) preloadMyEfrei();
      if (focusSettings.message) preloadMessage();
    };

    // Theme switching logic (dark/light mode detection)
    const applyTheme = () => {
      chrome.storage.local.get(['theme'], (result) => {
        const isDark = result.theme === 'dark' || (!result.theme && window.matchMedia('(prefers-color-scheme: dark)').matches);
        if (isDark) {
          document.body.classList.remove('ultramoodle-light');
          document.body.classList.add('ultramoodle-dark');
        } else {
          document.body.classList.remove('ultramoodle-dark');
          document.body.classList.add('ultramoodle-light');
        }
      });
    };

    // Initialize Page
    const initChatbotPage = () => {
      applyTheme();

      chrome.storage.local.get(['focus_myefrei', 'focus_moodle', 'focus_message', 'ai_mode', 'ai_provider', 'ai_apikey'], (res) => {
        focusSettings.myefrei = res.focus_myefrei !== false;
        focusSettings.moodle = res.focus_moodle !== false;
        focusSettings.message = res.focus_message !== false;
        
        aiMode = res.ai_mode || 'simple';
        aiProvider = res.ai_provider || 'gemini';
        aiApiKey = res.ai_apikey || '';
        
        injectPortalChatUI();
      });
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initChatbotPage);
    } else {
      initChatbotPage();
    }

})();