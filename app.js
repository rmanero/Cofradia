(function () {
  "use strict";
  var $ = function (s) { return document.querySelector(s); };
  var D = window.COFRADIA_DATA || { cofrades: [], sitios: [], votos: {} };

  function h(tag, props) {
    var e = document.createElement(tag);
    if (props) Object.keys(props).forEach(function (k) {
      var v = props[k];
      if (v == null || v === false) return;
      if (k === "class") e.className = v;
      else if (k === "text") e.textContent = v;
      else if (k.indexOf("on") === 0) e.addEventListener(k.slice(2), v);
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
  function fmt1(n) { return n.toLocaleString("es-ES", { minimumFractionDigits: 1, maximumFractionDigits: 1 }); }
  function fmtDate(s) {
    var p = String(s || "").split("-");
    if (p.length !== 3) return "";
    var d = new Date(+p[0], +p[1] - 1, +p[2]);
    return isNaN(d) ? "" : d.toLocaleDateString("es-ES", { day: "numeric", month: "short", year: "numeric" });
  }
  var byId = {};
  D.cofrades.forEach(function (c) { byId[c.id] = c; });

  function stats(s) {
    var v = D.votos[s.id] || {}, rows = [];
    Object.keys(v).forEach(function (cid) {
      if (typeof v[cid] === "number" && byId[cid]) rows.push({ c: byId[cid], score: v[cid] });
    });
    var sum = rows.reduce(function (a, r) { return a + r.score; }, 0);
    return { rows: rows, n: rows.length, avg: rows.length ? sum / rows.length : null };
  }
  function metaOf(s, withDate) {
    return [s.zona, withDate ? fmtDate(s.fecha) : "", s.precio != null && s.precio !== "" ? s.precio + " € por cabeza" : ""].filter(Boolean).join(" · ");
  }

  function openLb(src, cap) {
    $("#lbImg").src = src; $("#lbImg").alt = cap; $("#lbCap").textContent = cap;
    $("#lb").hidden = false; $("#lbClose").focus();
  }
  function closeLb() { $("#lb").hidden = true; $("#lbImg").removeAttribute("src"); }
  $("#lbClose").addEventListener("click", closeLb);
  $("#lb").addEventListener("click", function (e) { if (e.target === e.currentTarget) closeLb(); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !$("#lb").hidden) closeLb(); });

  var withStats = D.sitios.map(function (s) { return { s: s, st: stats(s) }; });
  var voted = withStats.filter(function (r) { return r.st.n > 0; }).sort(function (a, b) {
    return b.st.avg - a.st.avg || b.st.n - a.st.n || a.s.nombre.localeCompare(b.s.nombre, "es");
  });
  var unvoted = withStats.filter(function (r) { return r.st.n === 0; }).sort(function (a, b) {
    return a.s.nombre.localeCompare(b.s.nombre, "es");
  });
  var posOf = {};
  voted.forEach(function (r, i) { posOf[r.s.id] = i + 1; });

  var nVotantes = {};
  Object.keys(D.votos).forEach(function (sid) { Object.keys(D.votos[sid] || {}).forEach(function (cid) { nVotantes[cid] = 1; }); });
  var nv = Object.keys(nVotantes).length;
  $("#stats").replaceChildren(
    h("span", null, h("b", { text: String(D.cofrades.length) }), D.cofrades.length === 1 ? " cofrade" : " cofrades"),
    h("span", null, h("b", { text: String(D.sitios.length) }), D.sitios.length === 1 ? " hamburguesería" : " hamburgueserías"),
    h("span", null, h("b", { text: String(nv) }), nv === 1 ? " cofrade ha votado" : " cofrades han votado")
  );

  function rankItem(r, pos) {
    var s = r.s, st = r.st, meta = metaOf(s, true);
    return h("li", { class: "rank-item" + (pos === 1 ? " top1" : "") },
      h("div", { class: "pos", text: pos ? String(pos) : "–" }),
      h("div", { class: "rank-main" }, h("h3", { text: s.nombre }), meta ? h("p", { class: "meta", text: meta }) : null),
      h("div", { class: "score" },
        st.n ? h("div", { class: "avg" }, fmt1(st.avg), h("i", { text: " /10" })) : h("div", { class: "avg", text: "–" }),
        h("span", { class: "n", text: st.n + (st.n === 1 ? " voto" : " votos") })),
      st.n ? h("div", { class: "bar" }, h("span", { style: "width:" + Math.round(st.avg * 10) + "%" })) : null,
      st.n ? h("details", { class: "voters" },
        h("summary", { text: "Quién ha votado (" + st.n + ")" }),
        h("ul", { class: "voter-list" }, st.rows.slice().sort(function (a, b) { return b.score - a.score; }).map(function (row) {
          return h("li", null, row.c.nombre, h("b", { text: String(row.score) }));
        }))) : null
    );
  }

  var rl = $("#rankingList");
  if (!D.sitios.length) {
    rl.replaceChildren(h("div", { class: "empty-pub" }, h("b", { text: "La plancha se está calentando" }), "Todavía no hay hamburgueserías en el ranking. Vuelve después de la próxima cena."));
  } else {
    var kids = [h("ol", { class: "ranking" }, voted.map(function (r, i) { return rankItem(r, i + 1); }))];
    if (unvoted.length) {
      kids.push(h("p", { class: "label unvoted-title", text: voted.length ? "Esperando votos" : "Sin votos todavía" }));
      kids.push(h("ol", { class: "ranking" }, unvoted.map(function (r) { return rankItem(r, 0); })));
    }
    rl.replaceChildren.apply(rl, kids);
  }

  var chrono = D.sitios.slice().sort(function (a, b) { return String(a.fecha).localeCompare(String(b.fecha)); });
  var num = {};
  chrono.forEach(function (s, i) { num[s.id] = i + 1; });
  var cl = $("#cronicasList");
  if (!chrono.length) {
    cl.replaceChildren(h("div", { class: "empty-pub" }, h("b", { text: "Sin crónicas todavía" }), "Aquí irán las historias de cada cena."));
  } else {
    cl.replaceChildren(h("div", { class: "tickets" }, chrono.slice().reverse().map(function (s) {
      var st = stats(s), fotos = s.fotos || [];
      return h("article", { class: "ticket" },
        h("div", { class: "ticket-head" },
          h("span", null, "CENA Nº ", h("b", { text: String(num[s.id]) })),
          h("span", { text: fmtDate(s.fecha) })),
        h("div", { class: "ticket-body" },
          h("h3", { text: s.nombre }),
          metaOf(s, false) ? h("p", { class: "meta", text: metaOf(s, false) }) : null,
          s.cronica ? h("p", { class: "cronica", text: s.cronica }) : null,
          fotos.length ? h("div", { class: "gallery" }, fotos.map(function (src, i) {
            return h("button", { class: "thumb", type: "button", "aria-label": "Ver foto " + (i + 1) + " de " + s.nombre, onclick: function () { openLb(src, s.nombre); } },
              h("img", { src: src, alt: "Foto " + (i + 1) + " de " + s.nombre, loading: "lazy" }));
          })) : null,
          h("div", { class: "ticket-score" },
            st.n ? h("span", null, "Nota ", h("b", { text: fmt1(st.avg) + "/10" })) : h("span", { text: "Sin votos" }),
            posOf[s.id] ? h("span", { text: "Puesto " + posOf[s.id] + " del ranking" }) : null))
      );
    })));
  }

  var ro = $("#rosterList");
  if (!D.cofrades.length) {
    ro.replaceChildren(h("div", { class: "empty-pub" }, h("b", { text: "La mesa se está llenando" }), "Pronto aparecerán aquí los miembros de la cofradía."));
  } else {
    ro.replaceChildren(h("ul", { class: "roster" }, D.cofrades.map(function (c) {
      return h("li", { class: "member" },
        c.foto ? h("img", { class: "avatar", src: c.foto, alt: "Foto de " + c.nombre })
               : h("span", { class: "avatar ph", "aria-hidden": "true", text: c.nombre.charAt(0).toUpperCase() }),
        h("div", { class: "member-text" }, h("h3", { text: c.nombre }), c.descripcion ? h("p", { text: c.descripcion }) : null));
    })));
  }
})();
