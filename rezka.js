/*!
 * HDREZKA plugin for Lampa (v2, через Cloudflare Worker — без проблем с CORS)
 * Настройки: Lampa → Настройки → HDREZKA → URL прокси (Worker), логин, пароль.
 */
(function () {
    'use strict';
    if (window.rezka_plugin_ready) return;
    window.rezka_plugin_ready = true;

    var S = {
        proxy: 'rezka_proxy_url', token: 'rezka_proxy_token', domain: 'rezka_domain',
        login: 'rezka_login', password: 'rezka_password', cookie: 'rezka_cookie', status: 'rezka_status'
    };

    function get(k, d) { var v = Lampa.Storage.get(k, d === undefined ? '' : d); return (v === null || v === undefined) ? '' : String(v); }
    function getDomain() {
        var d = get(S.domain).trim() || 'https://rezka.fi';
        if (!/^https?:\/\//i.test(d)) d = 'https://' + d;
        return d.replace(/\/+$/, '');
    }
    function getProxy() { return get(S.proxy).trim().replace(/\/+$/, ''); }
    function isLoggedIn() { return get(S.status) === 'logged' && !!get(S.cookie); }

    function call(path, opts, ok, fail) {
        var proxy = getProxy();
        if (!proxy) { fail('Не указан URL прокси (Настройки → HDREZKA)'); return; }
        var xhr = new XMLHttpRequest();
        xhr.open(opts.method || 'GET', proxy + path, true);
        xhr.timeout = 20000;
        if (opts.body) xhr.setRequestHeader('Content-Type', opts.contentType || 'application/x-www-form-urlencoded');
        if (opts.ajax) xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
        var ck = get(S.cookie); if (ck && opts.cookie !== false) xhr.setRequestHeader('X-Cookie', ck);
        var tk = get(S.token).trim(); if (tk) xhr.setRequestHeader('X-Token', tk);
        xhr.onload = function () {
            if (xhr.status === 403) return fail('Прокси: неверный токен');
            if (xhr.status >= 400) return fail('Ошибка ' + xhr.status);
            ok(xhr.responseText);
        };
        xhr.onerror = function () { fail('Сетевая ошибка: прокси недоступен'); };
        xhr.ontimeout = function () { fail('Превышено время ожидания'); };
        xhr.send(opts.body || null);
    }
    function remote(url, opts, ok, fail) {
        call('/fetch?url=' + encodeURIComponent(url), opts, ok, fail);
    }

    function authenticate(login, password, cb) {
        call('/login', {
            method: 'POST', contentType: 'application/json', cookie: false,
            body: JSON.stringify({ domain: getDomain(), login: login, password: password })
        }, function (txt) {
            var j; try { j = JSON.parse(txt); } catch (e) { return cb(false, 'Некорректный ответ прокси'); }
            if (j.success && j.cookie) {
                Lampa.Storage.set(S.cookie, j.cookie);
                Lampa.Storage.set(S.status, 'logged');
                cb(true, 'Успешный вход');
            } else {
                Lampa.Storage.set(S.status, 'guest');
                cb(false, j.message || 'Не удалось войти');
            }
        }, function (msg) { Lampa.Storage.set(S.status, 'guest'); cb(false, msg); });
    }
    function logout() { Lampa.Storage.set(S.cookie, ''); Lampa.Storage.set(S.status, 'guest'); }

    function decodeTrash(data) {
        if (!data || typeof data !== 'string' || data.charAt(0) !== '#') return data;
        var trash = ['$$!!@$$@^!@#$$@', '@@@@@!##!^^^', '####^!!##!@@', '^^^!@##!!##', '$$#!!@#!@##'];
        function enc(s) { return btoa(encodeURIComponent(s).replace(/%([0-9A-F]{2})/g, function (m, p) { return String.fromCharCode(parseInt(p, 16)); })); }
        function dec(s) { return decodeURIComponent(atob(s).split('').map(function (c) { return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2); }).join('')); }
        var x = data.substring(2);
        trash.forEach(function (t) { x = x.split('//_//' + enc(t)).join(''); });
        try { return dec(x); } catch (e) { try { return atob(x); } catch (e2) { return ''; } }
    }
    function parsePlaylist(str) {
        var out = [];
        (str || '').split(',').forEach(function (part) {
            var m = part.match(/\[([^\]]+)\](.+)/); if (!m) return;
            var urls = m[2].split(' or ');
            out.push({ label: m[1].trim(), file: urls[urls.length - 1].trim() });
        });
        return out;
    }
    function parseSubtitles(s) {
        if (!s || typeof s !== 'string') return [];
        return s.split(',').map(function (p) { var m = p.match(/\[([^\]]+)\](.+)/); return m ? { label: m[1], url: m[2] } : null; }).filter(Boolean);
    }

    function searchRezka(query, year, cb) {
        remote(getDomain() + '/engine/ajax/search.php', {
            method: 'POST', ajax: true, body: 'q=' + encodeURIComponent(query)
        }, function (html) {
            var div = document.createElement('div'); div.innerHTML = html;
            var items = [];
            div.querySelectorAll('a').forEach(function (a) {
                var href = a.getAttribute('href'); if (!href || href.indexOf('search') !== -1) return;
                var en = a.querySelector('.enty');
                var full = (a.textContent || '').trim();
                var title = en ? en.textContent.trim() : full.replace(/\s*\([^)]*\d{4}\)[\s\S]*$/, '').trim();
                var ym = full.match(/\b(19|20)\d{2}\b/);
                items.push({ url: href, title: title, year: ym ? ym[0] : '' });
            });
            if (year) { var ex = items.filter(function (i) { return i.year == String(year); }); if (ex.length) items = ex; }
            cb(items);
        }, function () { cb([]); });
    }

    function fetchFilmPage(filmUrl, cb, err) {
        remote(filmUrl, {}, function (str) {
            var info = { film_id: '', is_series: false, favs: '', voice: [], season: [], episode: [] };
            var idm = str.match(/initCDN(?:Series|Movies)Events\(\s*(\d+)\s*,\s*(\d+)\s*,\s*([01])\s*,\s*([01])\s*(?:,\s*([01]))?/);
            if (!idm) return err('Не удалось разобрать страницу');
            info.film_id = idm[1];
            var defVoice = idm[2], camrip = idm[3], ads = idm[4], director = idm[5] || '0';
            info.is_series = /initCDNSeriesEvents/.test(str);
            var fm = str.match(/data-favs="([^"]+)"/) || str.match(/var\s+sof\s*=.*?\.send\([^,]+,\s*'([^']+)'/);
            if (fm) info.favs = fm[1];

            var tm = str.match(/<ul[^>]+class="b-translator__list"[\s\S]*?<\/ul>/);
            if (tm) {
                var d = document.createElement('div'); d.innerHTML = tm[0];
                d.querySelectorAll('.b-translator__item').forEach(function (li) {
                    info.voice.push({
                        name: (li.getAttribute('title') || li.textContent || '').trim(),
                        id: li.getAttribute('data-translator_id') || defVoice,
                        is_camrip: li.getAttribute('data-camrip') || camrip,
                        is_ads: li.getAttribute('data-ads') || ads,
                        is_director: li.getAttribute('data-director') || director
                    });
                });
            }
            if (!info.voice.length) info.voice.push({ name: 'Оригинал', id: defVoice, is_camrip: camrip, is_ads: ads, is_director: director });

            if (info.is_series) {
                var sm = str.match(/<ul[^>]+class="b-simple_seasons__list"[\s\S]*?<\/ul>/);
                if (sm) {
                    var ds = document.createElement('div'); ds.innerHTML = sm[0];
                    ds.querySelectorAll('.b-simple_season__item').forEach(function (li) {
                        info.season.push({ name: li.textContent.trim(), id: li.getAttribute('data-tab_id') });
                    });
                }
                (str.match(/<ul[^>]+class="b-simple_episodes__list"[\s\S]*?<\/ul>/g) || []).forEach(function (block) {
                    var de = document.createElement('div'); de.innerHTML = block;
                    de.querySelectorAll('.b-simple_episode__item').forEach(function (li) {
                        info.episode.push({ name: li.textContent.trim(), season_id: li.getAttribute('data-season_id'), episode_id: li.getAttribute('data-episode_id') });
                    });
                });
            }
            cb(info);
        }, err);
    }

    function getStream(info, voice, season, episode, cb, err) {
        var post;
        if (info.is_series && season && episode) {
            post = 'id=' + encodeURIComponent(info.film_id) + '&translator_id=' + encodeURIComponent(voice.id) +
                '&season=' + encodeURIComponent(season.id) + '&episode=' + encodeURIComponent(episode.episode_id) +
                '&favs=' + encodeURIComponent(info.favs) + '&action=get_stream';
        } else {
            post = 'id=' + encodeURIComponent(info.film_id) + '&translator_id=' + encodeURIComponent(voice.id) +
                '&is_camrip=' + (voice.is_camrip || 0) + '&is_ads=' + (voice.is_ads || 0) + '&is_director=' + (voice.is_director || 0) +
                '&favs=' + encodeURIComponent(info.favs) + '&action=get_movie';
        }
        remote(getDomain() + '/ajax/get_cdn_series/?t=' + Date.now(), { method: 'POST', ajax: true, body: post }, function (txt) {
            var j; try { j = JSON.parse(txt); } catch (e) { return err('Не удалось разобрать ответ'); }
            if (!j.success) return err(j.message || 'Сервер вернул ошибку');
            var items = parsePlaylist(decodeTrash(j.url));
            if (!items.length) return err('Пустой плейлист');
            var q = {}; items.forEach(function (it) { q[it.label] = it.file; });
            cb({ file: items[items.length - 1].file, quality: q, subtitles: parseSubtitles(j.subtitle) });
        }, err);
    }

    function component(object) {
        var scroll = new Lampa.Scroll({ mask: true, over: true });
        var files = new Lampa.Explorer(object);
        var filter = new Lampa.Filter(object);
        var html = $('<div></div>');
        var state = { info: null, choice: { voice: 0, season: 0 } };
        var self = this;

        this.create = function () {
            scroll.minus();
            files.appendFiles(scroll.render());
            files.appendHead(filter.render());
            filter.onBack = function () { self.start(); };
            return this.render();
        };
        this.render = function () { return files.render(); };
        this.start = function () {
            if (Lampa.Activity.active().activity !== this.activity) return;
            Lampa.Controller.add('content', {
                toggle: function () { Lampa.Controller.collectionSet(scroll.render(), files.render()); Lampa.Controller.collectionFocus(false, scroll.render()); },
                up: function () { if (Navigator.canmove('up')) Navigator.move('up'); else Lampa.Controller.toggle('head'); },
                down: function () { Navigator.move('down'); },
                left: function () { Lampa.Controller.toggle('menu'); },
                right: function () { Navigator.move('right'); },
                back: this.back
            });
            Lampa.Controller.toggle('content');
        };
        this.pause = function () {}; this.stop = function () {};
        this.back = function () { Lampa.Activity.backward(); };
        this.destroy = function () { scroll.destroy(); files.destroy(); filter.destroy(); html.remove(); };

        function showError(msg) { html.empty(); html.append(new Lampa.Empty({ text: msg }).render()); scroll.append(html); }

        function buildList() {
            html.empty();
            var info = state.info; if (!info) return;
            var voice = info.voice[state.choice.voice] || info.voice[0];
            var season = info.season[state.choice.season];
            var items = (info.is_series && season)
                ? info.episode.filter(function (e) { return String(e.season_id) === String(season.id); })
                : [{ name: 'Смотреть фильм', episode_id: 0, season_id: 0 }];
            items.forEach(function (ep) {
                var item = $('<div class="online selector"><div class="online__title">' + Lampa.Utils.escape(ep.name) +
                    '</div><div class="online__quality">' + Lampa.Utils.escape(voice.name) + '</div></div>');
                item.on('hover:enter', function () {
                    Lampa.Noty.show('HDREZKA: получаю ссылку…');
                    getStream(info, voice, info.is_series ? season : null, info.is_series ? ep : null, function (d) {
                        var t = object.movie.title || object.movie.name || '';
                        Lampa.Player.play({ url: d.file, title: t, quality: d.quality, subtitles: d.subtitles });
                        Lampa.Player.playlist([{ url: d.file, title: t, quality: d.quality, subtitles: d.subtitles }]);
                    }, function (m) { Lampa.Noty.show('HDREZKA: ' + m); });
                });
                html.append(item);
            });
            scroll.append(html);
            Lampa.Controller.enable('content');
        }
        function buildFilter() {
            var info = state.info; if (!info) return;
            var f = [{ title: 'Перевод', subtitle: (info.voice[state.choice.voice] || {}).name || '—', stype: 'voice' }];
            if (info.is_series) f.push({ title: 'Сезон', subtitle: (info.season[state.choice.season] || {}).name || '—', stype: 'season' });
            filter.set('filter', f);
            filter.onSelect = function (type, a, b) {
                if (a.stype) { state.choice[a.stype] = b.index; buildFilter(); buildList(); }
            };
        }

        this.initialize = function () {
            this.activity.loader(true);
            var m = object.movie || {};
            var title = m.title || m.name || '';
            var year = (m.release_date || m.first_air_date || '').slice(0, 4);
            function fail(msg) { self.activity.loader(false); showError(msg); self.activity.toggle(); }
            if (!getProxy()) return fail('Укажи URL прокси: Настройки → HDREZKA');
            searchRezka(title, year, function (res) {
                if (!res.length) return fail('Ничего не найдено на HDREZKA');
                fetchFilmPage(res[0].url, function (info) {
                    state.info = info; self.activity.loader(false);
                    buildFilter(); buildList(); self.activity.toggle();
                }, fail);
            });
        };
    }

    function openRezka(movie) {
        Lampa.Activity.push({ url: '', title: 'HDREZKA - ' + (movie.title || movie.name || ''), component: 'rezka_online', movie: movie, page: 1 });
    }

    function addCardButton() {
        Lampa.Listener.follow('full', function (e) {
            if (e.type !== 'complite') return;
            var render = e.object.activity.render();
            if (render.find('.view--rezka').length) return;
            var btn = $('<div class="full-start__button selector view--rezka"><span>HDREZKA</span></div>');
            btn.on('hover:enter', function () { openRezka(e.data.movie); });
            var anchor = render.find('.view--torrent');
            if (anchor.length) anchor.after(btn); else render.find('.full-start__buttons, .full-start-new__buttons').first().append(btn);
        });
    }

    function statusText() { return isLoggedIn() ? 'Вы вошли в аккаунт' : 'Гость (не авторизован)'; }

    function addSettings() {
        Lampa.SettingsApi.addComponent({
            component: 'rezka', name: 'HDREZKA',
            icon: '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>'
        });
        function input(name, def, title, descr) {
            Lampa.SettingsApi.addParam({ component: 'rezka', param: { name: name, type: 'input', default: def }, field: { name: title, description: descr || '' } });
        }
        input(S.proxy, '', 'URL прокси (Worker)', 'https://имя.аккаунт.workers.dev');
        input(S.token, '', 'Токен прокси', 'Если задан TOKEN в Worker');
        input(S.domain, 'https://rezka.fi', 'Домен', 'Зеркало HDREZKA');
        input(S.login, '', 'Логин / e-mail');
        input(S.password, '', 'Пароль');
        Lampa.SettingsApi.addParam({
            component: 'rezka', param: { name: 'rezka_do_login', type: 'static' },
            field: { name: 'Войти', description: 'Статус: ' + statusText() },
            onRender: function (item) {
                item.on('hover:enter', function () {
                    var l = get(S.login), p = get(S.password);
                    if (!l || !p) return Lampa.Noty.show('Введите логин и пароль');
                    Lampa.Noty.show('HDREZKA: вход…');
                    authenticate(l, p, function (ok, msg) {
                        Lampa.Noty.show('HDREZKA: ' + msg);
                        item.find('.settings-param__descr').text('Статус: ' + statusText());
                    });
                });
            }
        });
        Lampa.SettingsApi.addParam({
            component: 'rezka', param: { name: 'rezka_do_logout', type: 'static' },
            field: { name: 'Выйти', description: 'Сбросить сессию' },
            onRender: function (item) {
                item.on('hover:enter', function () { logout(); Lampa.Noty.show('HDREZKA: сессия сброшена'); });
            }
        });
    }

    function start() {
        Lampa.Component.add('rezka_online', component);
        addSettings();
        addCardButton();
    }
    if (window.appready) start();
    else Lampa.Listener.follow('app', function (e) { if (e.type === 'ready') start(); });
})();
