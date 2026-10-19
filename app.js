/* La cofradía smashburguer. Lee y escribe en Supabase con fetch (sin librerías). */
(function () {
  "use strict";
  var $ = function (s) { return document.querySelector(s); };

  function h(tag, props) {
    var e = document.createElement(tag);
    if (props) Object.keys(props).forEach(function (k) {
      var v = props[k];
      if (v == null || v === false) return;
      if (k === "class") e.className = v;
      else if (k === "text") e.textContent = v;
      else if (k.indexOf("on") === 0) e.addEventListener(k.slice(2), v);
      else if (v === true) e.setAttribute(k, "");
      else e.setAttribute(k, v);
    });
    for (var i = 2; i < arguments.length; i++) {
      var kids = [].concat(arguments[i]);
      for (var j = 0; j < kids.length; j++) {
        var kid = kids[j];
        if (kid == null || kid === false) continue;
        e.append(kid && kid.nodeType ? kid : document.createTextNode(String(kid)));
      }
    }
    return e;
  }

  /* ---------- configuración y estado ---------- */
  var CFG = window.COFRADIA_CONFIG || {};
  var configured = !!(CFG.url && CFG.key);
  var BASE = String(CFG.url || "").replace(/\/+$/, "") + "/rest/v1";
  var MAX_FOTOS = 6;
  var LS_KEY = "cofradia.code";

  var S = { cofrades: [], sitios: [], votos: [], comentarios: [], fotos: [] };
  var loaded = false, loadError = "";
  var me = null, code = lsGet(LS_KEY) || "";
  var drafts = {}, pending = [], sharedTarget = null, lbState = null;
  var confirmSitio = null, confirmCof = null, confirmCode = null;
  var editingCof = null, editingSitio = null, cfPhoto, loginMsg = "", sessKey = null;
  var raf = 0, queue = Promise.resolve(), busy = 0;

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch (e) {} }

  /* ---------- acceso a Supabase ---------- */
  function headers() {
    var hd = { apikey: CFG.key, "Content-Type": "application/json" };
    if (/^eyJ/.test(CFG.key)) hd.Authorization = "Bearer " + CFG.key;
    return hd;
  }
  async function request(url, opts) {
    var res;
    try { res = await fetch(url, opts); }
    catch (e) { throw { code: "red" }; }
    var text = await res.text(), body = null;
    if (text) { try { body = JSON.parse(text); } catch (e) { body = text; } }
    if (!res.ok) throw { code: (body && body.message) || ("http_" + res.status), status: res.status };
    return body;
  }
  function rest(path) { return request(BASE + "/" + path, { headers: headers() }); }
  function rpc(fn, args) { return request(BASE + "/rpc/" + fn, { method: "POST", headers: headers(), body: JSON.stringify(args || {}) }); }

  var ERR = {
    red: "No hay conexión con la base de datos. Revisa tu internet.",
    codigo_invalido: "Ese código no es válido.",
    solo_admin: "Solo el administrador puede hacer eso.",
    sin_permiso: "No tienes permiso para hacer eso.",
    maximo_fotos: "Esa cena ya tiene 6 fotos.",
    formato_invalido: "Esa imagen no se puede usar. Prueba con otra.",
    no_existe: "Eso ya no existe. Recarga la página.",
    no_borrar_admin: "No se puede eliminar al administrador.",
    ya_configurado: "La cofradía ya está configurada.",
    codigo_corto: "El código debe tener al menos 4 caracteres."
  };
  function errText(e) { return (e && ERR[e.code]) || "No se pudo completar la acción. Inténtalo otra vez."; }

  /* ---------- utilidades ---------- */
  function fmt1(n) { return n.toLocaleString("es-ES", { minimumFractionDigits: 1, maximumFractionDigits: 1 }); }
  function fmtDate(s) {
    var p = String(s || "").slice(0, 10).split("-");
    if (p.length !== 3) return "";
    var d = new Date(+p[0], +p[1] - 1, +p[2]);
    return isNaN(d) ? "" : d.toLocaleDateString("es-ES", { day: "numeric", month: "short", year: "numeric" });
  }
  function fmtShort(iso) {
    var d = new Date(iso);
    return isNaN(d) ? "" : d.toLocaleDateString("es-ES", { day: "numeric", month: "short" });
  }
  function today() {
    var d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function byId(list, id) { for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i]; return null; }
  function cname(id) { var c = byId(S.cofrades, id); return c ? c.nombre : "Un cofrade"; }
  function isAdmin() { return !!(me && me.es_admin); }
  function canEditSitio(s) { return !!me && (me.es_admin || s.autor === me.id); }

  var flashTimer = 0;
  function flash(msg, sticky) {
    var el = $("#status"), toast = $("#toast");
    el.textContent = msg || "";
    toast.textContent = msg || "";
    toast.hidden = !msg;
    clearTimeout(flashTimer);
    if (msg && !sticky) flashTimer = setTimeout(function () { el.textContent = ""; toast.hidden = true; }, 4500);
  }
  function banner(html) {
    var b = $("#banner");
    b.hidden = !html;
    b.replaceChildren();
    if (html) b.append(html);
  }

  /* ---------- imágenes ---------- */
  function readAsDataURL(file) {
    return new Promise(function (res, rej) {
      var r = new FileReader();
      r.onload = function () { res(r.result); };
      r.onerror = function () { rej(r.error || new Error("No se puede leer el archivo")); };
      r.readAsDataURL(file);
    });
  }
  function imgFromFile(file) {
    return readAsDataURL(file).then(function (url) {
      return new Promise(function (res, rej) {
        var img = new Image();
        img.onload = function () { res(img); };
        img.onerror = function () { rej(new Error("Formato de imagen no admitido")); };
        img.src = url;
      });
    });
  }
  function loadBitmap(file) {
    if (window.createImageBitmap) {
      return createImageBitmap(file, { imageOrientation: "from-image" })
        .catch(function () { return createImageBitmap(file); })
        .catch(function () { return imgFromFile(file); });
    }
    return imgFromFile(file);
  }
  function bw(b) { return b.naturalWidth || b.width; }
  function bh(b) { return b.naturalHeight || b.height; }
  function scaleTo(bmp, maxSide, q, limit) {
    var k = Math.min(1, maxSide / Math.max(bw(bmp), bh(bmp)));
    var cw = Math.max(1, Math.round(bw(bmp) * k)), ch = Math.max(1, Math.round(bh(bmp) * k)), out = "";
    for (var i = 0; i < 6; i++) {
      var c = document.createElement("canvas");
      c.width = cw; c.height = ch;
      var ctx = c.getContext("2d");
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cw, ch);
      ctx.drawImage(bmp, 0, 0, cw, ch);
      out = c.toDataURL("image/jpeg", q);
      if (out.length <= limit) return out;
      q = Math.max(0.4, q - 0.1); cw = Math.round(cw * 0.85); ch = Math.round(ch * 0.85);
    }
    return out.length <= limit ? out : null;
  }
  function avatarFrom(bmp) {
    var s = Math.min(bw(bmp), bh(bmp)), sx = (bw(bmp) - s) / 2, sy = (bh(bmp) - s) / 3, size = 256, q = 0.8, out = "";
    for (var i = 0; i < 5; i++) {
      var c = document.createElement("canvas");
      c.width = c.height = size;
      var ctx = c.getContext("2d");
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, size, size);
      ctx.drawImage(bmp, sx, sy, s, s, 0, 0, size, size);
      out = c.toDataURL("image/jpeg", q);
      if (out.length <= 45000) return out;
      q = Math.max(0.5, q - 0.1); size = Math.round(size * 0.85);
    }
    return out.length <= 45000 ? out : null;
  }
  function onlyImages(list) {
    return [].slice.call(list || []).filter(function (f) {
      return (f.type || "").indexOf("image/") === 0 || (!f.type && /\.(jpe?g|png|gif|webp|heic|heif|bmp|avif)$/i.test(f.name || ""));
    });
  }
  async function uploadPhotos(sitioId, files) {
    var ok = 0, fail = 0, last = null;
    for (var i = 0; i < files.length; i++) {
      flash("Subiendo foto " + (i + 1) + " de " + files.length + "…", true);
      try {
        var bmp = await loadBitmap(files[i]);
        var mini = scaleTo(bmp, 480, 0.72, 60000), grande = scaleTo(bmp, 1280, 0.78, 200000);
        if (bmp.close) { try { bmp.close(); } catch (e) {} }
        if (!mini || !grande) throw { code: "formato_invalido" };
        await rpc("subir_foto", { p_code: code, p_sitio: sitioId, p_mini: mini, p_grande: grande });
        ok++;
      } catch (e) { fail++; last = e; }
    }
    return { ok: ok, fail: fail, err: last };
  }
  function reportUpload(r, prefix) {
    prefix = prefix || "";
    if (r.fail) flash(prefix + "No se pudieron subir " + r.fail + (r.fail === 1 ? " foto. " : " fotos. ") + (r.err && r.err.code && ERR[r.err.code] ? ERR[r.err.code] : "Prueba con otra imagen."), true);
    else flash(prefix + (r.ok ? (r.ok === 1 ? "Foto subida." : "Fotos subidas.") : ""));
  }

  /* ---------- datos ---------- */
  async function loadAll() {
    var r = await Promise.all([
      rest("cofrades?select=id,nombre,descripcion,foto,es_admin,creado&order=creado.asc"),
      rest("sitios?select=id,nombre,zona,fecha,precio,cronica,autor,creado&order=fecha.desc,creado.desc"),
      rest("votos?select=sitio_id,cofrade_id,nota"),
      rest("comentarios?select=id,sitio_id,cofrade_id,texto,creado&order=creado.asc"),
      rest("fotos?select=id,sitio_id,autor,mini,creado&order=creado.asc")
    ]);
    S = { cofrades: r[0] || [], sitios: r[1] || [], votos: r[2] || [], comentarios: r[3] || [], fotos: r[4] || [] };
    loaded = true; loadError = "";
    if (me) { var m = byId(S.cofrades, me.id); if (m) { me.nombre = m.nombre; me.es_admin = m.es_admin; } }
  }
  async function refresh() {
    if (!configured) return;
    try { await loadAll(); banner(null); }
    catch (e) { loadError = e && e.code === "red" ? "red" : "datos"; if (!loaded) showLoadError(); }
    render();
  }
  function showLoadError() {
    banner(h("span", { text: loadError === "red"
      ? "No hay conexión con la base de datos. Revisa tu internet y recarga la página."
      : "No se pueden leer los datos. Comprueba que has ejecutado el SQL y que la URL y la clave de config.js son correctas." }));
  }

  function statsFor(s) {
    var rows = [];
    S.votos.forEach(function (v) { if (v.sitio_id === s.id && byId(S.cofrades, v.cofrade_id)) rows.push({ voter: v.cofrade_id, score: v.nota }); });
    var sum = rows.reduce(function (a, r) { return a + r.score; }, 0);
    return { rows: rows, n: rows.length, avg: rows.length ? sum / rows.length : null };
  }
  function myVote(sid) {
    if (!me) return null;
    for (var i = 0; i < S.votos.length; i++) if (S.votos[i].sitio_id === sid && S.votos[i].cofrade_id === me.id) return S.votos[i].nota;
    return null;
  }
  function setVoteLocal(sid, cid, nota) {
    S.votos = S.votos.filter(function (v) { return !(v.sitio_id === sid && v.cofrade_id === cid); });
    if (nota != null) S.votos.push({ sitio_id: sid, cofrade_id: cid, nota: nota });
  }
  function fotosOf(id) { return S.fotos.filter(function (f) { return f.sitio_id === id; }); }

  /* ---------- sesión ---------- */
  function drawSession() {
    var box = $("#session");
    if (!configured) { box.hidden = true; return; }
    box.hidden = false;
    var key = me ? "me:" + me.id + ":" + me.nombre + ":" + me.es_admin : "anon";
    if (key === sessKey) return;
    sessKey = key;
    if (me) {
      box.replaceChildren(
        h("p", null, "Has entrado como ", h("span", { class: "who", text: me.nombre }), me.es_admin ? h("span", { class: "badge", text: "Admin" }) : null),
        h("button", { class: "linkbtn", type: "button", text: "Salir", onclick: logout }));
    } else {
      var input = h("input", { id: "loginCode", type: "text", maxlength: "20", autocomplete: "off", autocapitalize: "characters", spellcheck: "false", placeholder: "Tu código", "aria-label": "Tu código de cofrade" });
      var msg = h("p", { class: "hint err", id: "loginMsg", role: "status", text: loginMsg });
      box.replaceChildren(
        h("p", { class: "who", text: "¿Eres cofrade? Entra con tu código para votar y comentar." }),
        h("form", { id: "formLogin", onsubmit: function (ev) { ev.preventDefault(); doLogin(input.value); } },
          input, h("button", { class: "btn", type: "submit", text: "Entrar" })),
        msg);
    }
  }
  async function doLogin(value) {
    var c = String(value || "").trim().toUpperCase();
    if (!c) return;
    try {
      var r = await rpc("login", { p_code: c });
      if (!r) { loginMsg = "Ese código no es válido."; sessKey = null; render(); return; }
      me = r; code = c; lsSet(LS_KEY, c); loginMsg = ""; sessKey = null;
      flash("Bienvenido, " + me.nombre + ".");
      render();
    } catch (e) { loginMsg = errText(e); sessKey = null; render(); }
  }
  function logout() {
    me = null; code = ""; lsSet(LS_KEY, ""); sessKey = null;
    editingCof = null; editingSitio = null; cfPhoto = undefined; pending = [];
    confirmSitio = confirmCof = confirmCode = null;
    $("#codeBox").hidden = true;
    render();
  }

  /* ---------- pintado ---------- */
  function render() {
    if (raf) return;
    raf = requestAnimationFrame(function () { raf = 0; draw(); });
  }

  function draw() {
    drawSession();
    $("#navNueva").hidden = !me;
    $("#nueva").hidden = !me;

    var ae = document.activeElement;
    var keep = ae && ae.id && /^c-/.test(ae.id) ? ae.id : null;
    var sel = keep && ae.selectionStart != null ? [ae.selectionStart, ae.selectionEnd] : null;

    var ranked = S.sitios.map(function (s) { return { s: s, st: statsFor(s) }; });
    var voted = ranked.filter(function (r) { return r.st.n > 0; }).sort(function (a, b) {
      return b.st.avg - a.st.avg || b.st.n - a.st.n || a.s.nombre.localeCompare(b.s.nombre, "es");
    });
    var unvoted = ranked.filter(function (r) { return r.st.n === 0; }).sort(function (a, b) {
      return a.s.nombre.localeCompare(b.s.nombre, "es");
    });
    var posOf = {};
    voted.forEach(function (r, i) { posOf[r.s.id] = i + 1; });

    var voters = {};
    S.votos.forEach(function (v) { voters[v.cofrade_id] = 1; });
    var nVot = Object.keys(voters).filter(function (id) { return byId(S.cofrades, id); }).length;
    $("#stats").replaceChildren(
      h("span", null, h("b", { text: String(S.cofrades.length) }), S.cofrades.length === 1 ? " cofrade" : " cofrades"),
      h("span", null, h("b", { text: String(S.sitios.length) }), S.sitios.length === 1 ? " hamburguesería" : " hamburgueserías"),
      h("span", null, h("b", { text: String(nVot) }), nVot === 1 ? " cofrade ha votado" : " cofrades han votado"));

    drawRanking(voted, unvoted);
    drawCronicas(posOf);
    drawRoster();
    syncCofradeForm();
    syncSitioForm();

    if (keep) {
      var el = document.getElementById(keep);
      if (el) { el.focus(); if (sel) { try { el.setSelectionRange(sel[0], sel[1]); } catch (e) {} } }
    }
  }

  function drawRanking(voted, unvoted) {
    var rl = $("#rankingList");
    if (!configured) {
      rl.replaceChildren(h("div", { class: "setup-note" }, "La base de datos todavía no está conectada. Rellena ", h("code", { text: "config.js" }), " con los datos de tu proyecto de Supabase."));
      return;
    }
    if (!loaded) { rl.replaceChildren(h("p", { class: "loading", text: "Cargando el ranking…" })); return; }
    if (!S.sitios.length) {
      rl.replaceChildren(h("div", { class: "empty" },
        h("b", { text: "La plancha está vacía" }),
        me ? "Todavía no hay hamburgueserías. Registra la primera cena más abajo." : "Todavía no hay hamburgueserías. En cuanto un cofrade registre la primera cena aparecerá aquí."));
      return;
    }
    function rankItem(r, pos) {
      var s = r.s, st = r.st;
      var meta = [s.zona, fmtDate(s.fecha), s.precio != null && s.precio !== "" ? s.precio + " € por cabeza" : ""].filter(Boolean).join(" · ");
      var mine = myVote(s.id), voteBlock = null;
      if (me) {
        var buttons = [];
        for (var n = 1; n <= 10; n++) {
          (function (n) {
            buttons.push(h("button", { class: "vb", type: "button", "aria-pressed": String(mine === n), "aria-label": "Poner un " + n + " a " + s.nombre, text: String(n), onclick: function () { vote(s.id, n); } }));
          })(n);
        }
        voteBlock = h("div", { class: "vote" },
          h("div", { class: "vote-row", role: "group", "aria-label": "Tu nota para " + s.nombre }, buttons),
          h("p", { class: "hint", text: mine != null ? "Tu nota: " + mine + ". Pulsa la misma para retirarla." : "Aún no has votado este sitio." }));
      }
      return h("li", { class: "rank-item" + (pos === 1 ? " top1" : "") },
        h("div", { class: "pos", text: pos ? String(pos) : "–" }),
        h("div", { class: "rank-main" }, h("h3", { text: s.nombre }), meta ? h("p", { class: "meta", text: meta }) : null),
        h("div", { class: "score" },
          st.n ? h("div", { class: "avg" }, fmt1(st.avg), h("i", { text: " /10" })) : h("div", { class: "avg", text: "–" }),
          h("span", { class: "n", text: st.n + (st.n === 1 ? " voto" : " votos") })),
        st.n ? h("div", { class: "bar" }, h("span", { style: "width:" + Math.round(st.avg * 10) + "%" })) : null,
        voteBlock,
        st.n ? h("details", { class: "voters" },
          h("summary", { text: "Quién ha votado (" + st.n + ")" }),
          h("ul", { class: "voter-list" }, st.rows.slice().sort(function (a, b) { return b.score - a.score; }).map(function (row) {
            return h("li", null, cname(row.voter), h("b", { text: String(row.score) }));
          }))) : null);
    }
    var kids = [h("ol", { class: "ranking" }, voted.map(function (r, i) { return rankItem(r, i + 1); }))];
    if (unvoted.length) {
      kids.push(h("p", { class: "label unvoted-title", text: voted.length ? "Esperando votos" : "Sin votos todavía" }));
      kids.push(h("ol", { class: "ranking" }, unvoted.map(function (r) { return rankItem(r, 0); })));
    }
    rl.replaceChildren.apply(rl, kids);
  }

  function drawCronicas(posOf) {
    var cl = $("#cronicasList");
    if (!loaded) { cl.replaceChildren(); return; }
    var chrono = S.sitios.slice().sort(function (a, b) { return String(a.fecha).localeCompare(String(b.fecha)) || String(a.creado).localeCompare(String(b.creado)); });
    var num = {};
    chrono.forEach(function (s, i) { num[s.id] = i + 1; });
    if (!chrono.length) {
      cl.replaceChildren(h("div", { class: "empty" }, h("b", { text: "Sin crónicas" }), "Cuando se registre una cena, su crónica aparecerá aquí."));
      return;
    }
    cl.replaceChildren(h("div", { class: "tickets" }, chrono.slice().reverse().map(function (s) {
      var st = statsFor(s), list = fotosOf(s.id);
      var cms = S.comentarios.filter(function (c) { return c.sitio_id === s.id; });
      var canEdit = canEditSitio(s), canPhoto = !!me && list.length < MAX_FOTOS;
      var gallery = list.length ? h("div", { class: "gallery" }, list.map(function (f, i) {
        return h("button", { class: "thumb", type: "button", "aria-label": "Ver foto " + (i + 1) + " de " + s.nombre, onclick: function () { openLb(f, s); } },
          h("img", { src: f.mini, alt: "Foto " + (i + 1) + " de " + s.nombre, loading: "lazy" }));
      })) : null;
      var form = me ? h("form", { class: "comment-form", autocomplete: "off", onsubmit: function (ev) { ev.preventDefault(); addComment(s.id); } },
        h("input", { id: "c-" + s.id, type: "text", maxlength: "500", placeholder: "Añade tu comentario", "aria-label": "Comentario sobre " + s.nombre, value: drafts[s.id] || "", oninput: function (ev) { drafts[s.id] = ev.target.value; } }),
        h("button", { class: "btn ghost", type: "submit", text: "Comentar" }))
        : h("p", { class: "hint", text: "Entra con tu código para comentar." });
      var tools = [];
      if (canPhoto) tools.push(h("button", { class: "linkbtn", type: "button", text: "Añadir fotos", onclick: function () { sharedTarget = s.id; $("#sharedFile").click(); } }));
      if (canEdit) tools.push(h("button", { class: "linkbtn", type: "button", text: "Editar", onclick: function () { editSitio(s.id); } }));
      if (canEdit) {
        if (confirmSitio === s.id) {
          tools.push(h("button", { class: "linkbtn danger", type: "button", text: "Confirmar borrado", onclick: function () { removeSitio(s.id); } }));
          tools.push(h("button", { class: "linkbtn", type: "button", text: "Cancelar", onclick: function () { confirmSitio = null; render(); } }));
        } else tools.push(h("button", { class: "linkbtn", type: "button", text: "Borrar cena", onclick: function () { confirmSitio = s.id; render(); } }));
      }
      return h("article", { class: "ticket" },
        h("div", { class: "ticket-head" }, h("span", null, "CENA Nº ", h("b", { text: String(num[s.id]) })), h("span", { text: fmtDate(s.fecha) })),
        h("div", { class: "ticket-body" },
          h("h3", { text: s.nombre }),
          h("p", { class: "meta", text: [s.zona, s.precio != null && s.precio !== "" ? s.precio + " € por cabeza" : ""].filter(Boolean).join(" · ") || null }),
          s.cronica ? h("p", { class: "cronica", text: s.cronica }) : h("p", { class: "byline", text: "Sin crónica todavía." }),
          gallery,
          s.autor && byId(S.cofrades, s.autor) ? h("p", { class: "byline", text: "Contada por " + cname(s.autor) }) : null,
          h("div", { class: "ticket-score" },
            st.n ? h("span", null, "Nota ", h("b", { text: fmt1(st.avg) + "/10" })) : h("span", { text: "Sin votos" }),
            posOf[s.id] ? h("span", { text: "Puesto " + posOf[s.id] + " del ranking" }) : null)),
        h("div", { class: "comments" },
          cms.map(function (c) {
            var mine = !!me && (me.es_admin || c.cofrade_id === me.id);
            return h("p", { class: "comment" }, h("b", { text: cname(c.cofrade_id) }), h("time", { text: fmtShort(c.creado) }),
              mine ? h("button", { class: "linkbtn comment-del", type: "button", "aria-label": "Borrar comentario", text: "Borrar", onclick: function () { removeComment(c.id); } }) : null,
              h("br"), c.texto);
          }),
          form),
        tools.length ? h("div", { class: "ticket-tools" }, tools) : null);
    })));
  }

  function drawRoster() {
    var ro = $("#rosterList");
    if (!loaded) { ro.replaceChildren(); return; }
    if (!S.cofrades.length) {
      ro.replaceChildren(h("div", { class: "empty" }, h("b", { text: "Nadie en la mesa todavía" }),
        "Aún no hay cofrades. El administrador debe crear el primero con el comando de la guía de instalación."));
      return;
    }
    ro.replaceChildren(h("ul", { class: "roster" }, S.cofrades.map(function (c) {
      var nm = c.nombre || "Sin nombre", mine = !!me && me.id === c.id;
      var tools = [];
      if (me && (me.es_admin || mine)) tools.push(h("button", { class: "linkbtn", type: "button", text: mine ? "Editar mi perfil" : "Editar", onclick: function () { editCofrade(c.id); } }));
      if (isAdmin()) {
        if (confirmCode === c.id) {
          tools.push(h("button", { class: "linkbtn danger", type: "button", text: "Confirmar código nuevo", onclick: function () { newCode(c.id); } }));
          tools.push(h("button", { class: "linkbtn", type: "button", text: "Cancelar", onclick: function () { confirmCode = null; render(); } }));
        } else tools.push(h("button", { class: "linkbtn", type: "button", text: "Código nuevo", onclick: function () { confirmCode = c.id; confirmCof = null; render(); } }));
        if (!c.es_admin) {
          if (confirmCof === c.id) {
            tools.push(h("button", { class: "linkbtn danger", type: "button", text: "Confirmar", onclick: function () { removeCofrade(c.id); } }));
            tools.push(h("button", { class: "linkbtn", type: "button", text: "Cancelar", onclick: function () { confirmCof = null; render(); } }));
          } else tools.push(h("button", { class: "linkbtn", type: "button", text: "Eliminar", onclick: function () { confirmCof = c.id; confirmCode = null; render(); } }));
        }
      }
      return h("li", { class: "member" },
        c.foto ? h("img", { class: "avatar", src: c.foto, alt: "Foto de " + nm }) : h("span", { class: "avatar ph", "aria-hidden": "true", text: nm.charAt(0).toUpperCase() }),
        h("div", { class: "member-text" },
          h("h3", { text: nm }),
          mine ? h("span", { class: "label", text: "Eres tú" }) : null,
          c.descripcion ? h("p", { text: c.descripcion }) : null,
          tools.length ? h("div", { class: "member-tools" }, tools) : null));
    })));
  }

  /* ---------- acciones ---------- */
  function vote(sid, n) {
    if (!me) return;
    var nota = myVote(sid) === n ? null : n;
    setVoteLocal(sid, me.id, nota);
    render();
    queue = queue.then(function () { return rpc("votar", { p_code: code, p_sitio: sid, p_nota: nota }); })
      .catch(function (e) { flash(errText(e)); return refresh(); });
  }

  async function addComment(sid) {
    var text = (drafts[sid] || "").trim();
    if (!text || !me) return;
    drafts[sid] = "";
    try { await rpc("comentar", { p_code: code, p_sitio: sid, p_texto: text }); await refresh(); }
    catch (e) { drafts[sid] = text; flash(errText(e)); render(); }
  }
  async function removeComment(id) {
    try { await rpc("borrar_comentario", { p_code: code, p_id: id }); await refresh(); } catch (e) { flash(errText(e)); }
  }
  async function removeSitio(id) {
    confirmSitio = null;
    try { await rpc("borrar_sitio", { p_code: code, p_id: id }); if (editingSitio === id) resetSitioForm(); await refresh(); }
    catch (e) { flash(errText(e)); render(); }
  }
  async function removeCofrade(id) {
    confirmCof = null;
    try { await rpc("borrar_cofrade", { p_code: code, p_id: id }); if (editingCof === id) resetCofradeForm(); await refresh(); }
    catch (e) { flash(errText(e)); render(); }
  }

  function showCode(nombre, c) {
    var box = $("#codeBox"), link = location.origin + location.pathname;
    var wa = "https://wa.me/?text=" + encodeURIComponent("Hola " + nombre + ", tu código de La cofradía smashburguer es " + c + ". Entra en " + link + " y pulsa Entrar.");
    var codeEl = h("p", { class: "code", text: c });
    box.replaceChildren(h("div", { class: "codebox" },
      h("p", { class: "label", text: "Código de " + nombre }),
      codeEl,
      h("p", { text: "Pásaselo a " + nombre + ". Se muestra solo ahora: si se pierde, genera uno nuevo desde su ficha." }),
      h("div", { class: "row" },
        h("button", { class: "btn", type: "button", text: "Copiar código", onclick: function () {
          var done = function () { flash("Código copiado."); };
          if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(c).then(done).catch(function () { flash("No se pudo copiar. Mantén pulsado el código para copiarlo."); });
          else flash("Mantén pulsado el código para copiarlo.");
        } }),
        h("a", { class: "btn", href: wa, target: "_blank", rel: "noopener", text: "Enviar por WhatsApp" }),
        h("button", { class: "btn ghost", type: "button", text: "Cerrar", onclick: function () { box.hidden = true; box.replaceChildren(); } }))));
    box.hidden = false;
    box.scrollIntoView({ behavior: "smooth", block: "center" });
  }
  async function newCode(id) {
    confirmCode = null;
    try { var c = await rpc("nuevo_codigo", { p_code: code, p_id: id }); var cf = byId(S.cofrades, id); showCode(cf ? cf.nombre : "cofrade", c); }
    catch (e) { flash(errText(e)); }
    render();
  }

  /* ---------- formulario de cenas ---------- */
  function renderPreviews() {
    var box = $("#previews");
    box.replaceChildren.apply(box, pending.map(function (p, i) {
      return h("div", { class: "preview" },
        p.url ? h("img", { src: p.url, alt: "Foto " + (i + 1) + " seleccionada" }) : h("span", { class: "hint", text: "Cargando…" }),
        h("button", { type: "button", "aria-label": "Quitar foto " + (i + 1), text: "×", onclick: function () { pending.splice(i, 1); renderPreviews(); } }));
    }));
  }
  $("#f-fotos").addEventListener("change", function (ev) {
    var files = onlyImages(ev.target.files), over = false;
    if (!files.length && ev.target.files && ev.target.files.length) flash("Ese archivo no parece una imagen.");
    files.forEach(function (f) {
      if (pending.length < MAX_FOTOS) {
        var p = { file: f, url: "" };
        pending.push(p);
        readAsDataURL(f).then(function (u) { p.url = u; renderPreviews(); }).catch(function () { renderPreviews(); });
      } else over = true;
    });
    ev.target.value = "";
    if (over) flash("Máximo " + MAX_FOTOS + " fotos por cena.");
    renderPreviews();
  });

  function syncSitioForm() {
    var editing = editingSitio && byId(S.sitios, editingSitio);
    $("#f-enviar").textContent = editing ? "Guardar cambios" : "Guardar cena";
    $("#f-cancel").hidden = !editing;
    $("#fotosField").hidden = !!editing;
    $("#nueva-sub").textContent = editing ? "Editando «" + editing.nombre + "». Las fotos se añaden desde su crónica." : "Añade la hamburguesería y cuenta cómo fue. Después podréis votarla todos.";
  }
  function resetSitioForm() {
    editingSitio = null; pending = [];
    $("#formCena").reset();
    $("#f-fecha").value = today();
    renderPreviews(); syncSitioForm();
  }
  function editSitio(id) {
    var s = byId(S.sitios, id);
    if (!s) return;
    editingSitio = id;
    var f = $("#formCena");
    f.nombre.value = s.nombre || ""; f.zona.value = s.zona || ""; f.fecha.value = String(s.fecha || "").slice(0, 10);
    f.precio.value = s.precio == null ? "" : s.precio; f.cronica.value = s.cronica || "";
    syncSitioForm();
    $("#nueva").scrollIntoView({ behavior: "smooth", block: "start" });
  }
  $("#f-cancel").addEventListener("click", resetSitioForm);

  $("#formCena").addEventListener("submit", async function (ev) {
    ev.preventDefault();
    if (!me) return;
    var f = ev.target, nombre = f.nombre.value.trim();
    if (!nombre || !f.fecha.value) return;
    var precio = f.precio.value === "" ? null : Number(f.precio.value);
    var btn = $("#f-enviar");
    btn.disabled = true; busy++;
    try {
      if (editingSitio) {
        await rpc("editar_sitio", { p_code: code, p_id: editingSitio, p_nombre: nombre, p_zona: f.zona.value.trim(), p_fecha: f.fecha.value, p_precio: precio, p_cronica: f.cronica.value.trim() });
        resetSitioForm();
        flash("Cena actualizada.");
      } else {
        var id = await rpc("crear_sitio", { p_code: code, p_nombre: nombre, p_zona: f.zona.value.trim(), p_fecha: f.fecha.value, p_precio: precio, p_cronica: f.cronica.value.trim() });
        var files = pending.map(function (p) { return p.file; });
        resetSitioForm();
        if (files.length) reportUpload(await uploadPhotos(id, files), "Cena guardada. ");
        else flash("Cena guardada. Ya se puede votar.");
      }
      await refresh();
    } catch (e) { flash(errText(e)); }
    btn.disabled = false; busy--;
  });

  $("#sharedFile").addEventListener("change", async function (ev) {
    var files = onlyImages(ev.target.files), sid = sharedTarget;
    ev.target.value = "";
    if (!sid || !files.length || !me) return;
    var room = MAX_FOTOS - fotosOf(sid).length;
    if (room <= 0) { flash("Esta cena ya tiene " + MAX_FOTOS + " fotos."); return; }
    busy++;
    var r = await uploadPhotos(sid, files.slice(0, room));
    reportUpload(r, files.length > room ? "Solo caben " + MAX_FOTOS + " fotos por cena. " : "");
    await refresh();
    busy--;
  });

  /* ---------- formulario de cofrades ---------- */
  function syncCofradeForm() {
    var form = $("#formCofrade");
    var show = !!me && (me.es_admin || !!editingCof);
    form.hidden = !show;
    if (!show) return;
    var cur = editingCof && byId(S.cofrades, editingCof);
    var src = cfPhoto !== undefined ? cfPhoto : (cur && cur.foto) || "";
    var nm = $("#cf-nombre").value.trim() || (cur && cur.nombre) || "";
    $("#cf-avatar").replaceChildren(src ? h("img", { src: src, alt: "" }) : h("span", { text: (nm.charAt(0) || "?").toUpperCase() }));
    $("#cf-quitar").hidden = !src;
    $("#cf-enviar").textContent = cur ? "Guardar cambios" : "Añadir cofrade";
    $("#cf-title").textContent = cur ? "Editando a " + (cur.nombre || "cofrade") : "Nuevo cofrade";
    $("#cf-cancel").hidden = !cur;
  }
  function resetCofradeForm() { editingCof = null; cfPhoto = undefined; $("#formCofrade").reset(); }
  function editCofrade(id) {
    var c = byId(S.cofrades, id);
    if (!c) return;
    editingCof = id; cfPhoto = undefined;
    $("#cf-nombre").value = c.nombre || ""; $("#cf-desc").value = c.descripcion || "";
    syncCofradeForm();
    $("#formCofrade").scrollIntoView({ behavior: "smooth", block: "center" });
  }
  $("#formCofrade").addEventListener("input", syncCofradeForm);
  $("#cf-cancel").addEventListener("click", function () { resetCofradeForm(); syncCofradeForm(); });
  $("#cf-foto").addEventListener("change", async function (ev) {
    var file = onlyImages(ev.target.files)[0];
    ev.target.value = "";
    if (!file) return;
    try {
      var bmp = await loadBitmap(file);
      var out = avatarFrom(bmp);
      if (bmp.close) { try { bmp.close(); } catch (e) {} }
      if (!out) throw new Error("size");
      cfPhoto = out;
    } catch (e) { flash("No se pudo usar esa foto. Prueba con otra imagen."); }
    syncCofradeForm();
  });
  $("#cf-quitar").addEventListener("click", function () { cfPhoto = null; syncCofradeForm(); });

  $("#formCofrade").addEventListener("submit", async function (ev) {
    ev.preventDefault();
    if (!me) return;
    var f = ev.target, nombre = f.cfnombre.value.trim();
    if (!nombre) return;
    var btn = $("#cf-enviar");
    btn.disabled = true; busy++;
    try {
      if (editingCof) {
        await rpc("editar_cofrade", { p_code: code, p_id: editingCof, p_nombre: nombre, p_desc: f.cfdesc.value.trim(), p_foto: cfPhoto === undefined ? null : (cfPhoto || "") });
        resetCofradeForm();
        flash("Cofrade actualizado.");
      } else {
        var c = await rpc("crear_cofrade", { p_code: code, p_nombre: nombre, p_desc: f.cfdesc.value.trim(), p_foto: cfPhoto || "" });
        resetCofradeForm();
        showCode(nombre, c);
      }
      await refresh();
    } catch (e) { flash(errText(e)); }
    btn.disabled = false; busy--;
    syncCofradeForm();
  });

  /* ---------- visor de fotos ---------- */
  function updateLbTools() {
    var b = $("#lbDel");
    var f = lbState && lbState.f;
    b.hidden = !(me && f && (me.es_admin || f.autor === me.id));
    b.textContent = lbState && lbState.confirm ? "Confirmar borrado" : "Borrar foto";
  }
  function openLb(f, s) {
    lbState = { f: f, s: s, confirm: false };
    $("#lb").hidden = false;
    $("#lbImg").src = f.mini; $("#lbImg").alt = "Foto de " + s.nombre; $("#lbCap").textContent = s.nombre;
    updateLbTools();
    $("#lbClose").focus();
    rpc("foto_grande", { p_id: f.id }).then(function (big) {
      if (lbState && lbState.f.id === f.id && typeof big === "string" && big) $("#lbImg").src = big;
    }).catch(function () {});
  }
  function closeLb() { lbState = null; $("#lb").hidden = true; $("#lbImg").removeAttribute("src"); }
  $("#lbClose").addEventListener("click", closeLb);
  $("#lb").addEventListener("click", function (ev) { if (ev.target === ev.currentTarget) closeLb(); });
  document.addEventListener("keydown", function (ev) { if (ev.key === "Escape" && lbState) closeLb(); });
  $("#lbDel").addEventListener("click", async function () {
    if (!lbState || !me) return;
    if (!lbState.confirm) { lbState.confirm = true; updateLbTools(); return; }
    var id = lbState.f.id;
    closeLb();
    try { await rpc("borrar_foto", { p_code: code, p_id: id }); await refresh(); } catch (e) { flash(errText(e)); }
  });

  /* ---------- arranque ---------- */
  async function start() {
    $("#f-fecha").value = today();
    if (!configured) {
      banner(h("span", { text: "Falta conectar la base de datos: rellena config.js con la URL y la clave de tu proyecto de Supabase." }));
      loaded = false; render(); return;
    }
    render();
    if (code) {
      try { var r = await rpc("login", { p_code: code }); if (r) me = r; else { code = ""; lsSet(LS_KEY, ""); } }
      catch (e) { /* sin conexión: se sigue como visitante */ }
    }
    await refresh();
    setInterval(function () { if (document.visibilityState === "visible" && !busy && !lbState) refresh(); }, 30000);
  }
  start();
})();
