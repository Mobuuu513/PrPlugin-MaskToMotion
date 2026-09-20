/* KEYPATH 1.0.21 — Built-in pixel tracker (exports frames, template-matches the box, calculates position/scale/rotation) + time-aligned apply */
(function () {
    var TICKS = 254016000000;
    var MATCH_TRANSFORM = "AE.ADBE Geometry2";
    var MATCH_MOTION = "AE.ADBE Motion";
    var BATCH_SIZE = 20;

    var state = {
        mode: "follow",
        channel: "xy",
        everyNth: 4,
        samples: [],
        srcUnit: "norm", // "norm" (0..1 Premiere position) or "px"
        srcSize: null,   // frame size the "px" samples were measured in (null = same as target sequence)
        busy: false,
    };

    function $(id) {
        return document.getElementById(id);
    }

    function isChecked(id, fallback) {
        var el = $(id);
        return el ? !!el.checked : fallback;
    }

    function setResult(text, cls) {
        var el = $("result");
        el.textContent = String(text || "");
        el.className = cls || "muted";
    }

    function tryPpro() {
        try {
            return require("premierepro");
        } catch (e) {
            return null;
        }
    }

    function bytesToText(u8) {
        if (!u8 || !u8.length) return "";
        var utf16 = (u8.length > 1 && u8[0] === 0xff && u8[1] === 0xfe) || (u8.length > 3 && u8[1] === 0 && u8[3] === 0);
        try {
            if (typeof TextDecoder !== "undefined") {
                return new TextDecoder(utf16 ? "utf-16le" : "utf-8").decode(u8).replace(/\u0000/g, "");
            }
        } catch (e) {}
        var out = "";
        for (var i = 0; i < u8.length; i += 8192) {
            out += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
        }
        return out.replace(/\u0000/g, "");
    }

    function asText(value) {
        if (value == null) return "";
        if (typeof value === "string") return value;
        if (typeof value === "number" || typeof value === "boolean") return String(value);
        if (typeof ArrayBuffer !== "undefined") {
            if (value instanceof ArrayBuffer) return bytesToText(new Uint8Array(value));
            if (ArrayBuffer.isView(value)) return bytesToText(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
        }
        if (typeof value === "object") {
            if (typeof value.text === "string") return value.text;
            if (typeof value.data === "string") return value.data;
            if (typeof value["text/plain"] === "string") return value["text/plain"];
            if (value.value != null && typeof value.value !== "object") return String(value.value);
            try {
                return JSON.stringify(value);
            } catch (e2) {
                return "";
            }
        }
        try {
            return String(value);
        } catch (e3) {
            return "";
        }
    }

    function clipboardText(data) {
        if (typeof data === "string") return data;
        if (!data || typeof data !== "object") return asText(data);
        var order = ["text/plain", "text/html", "text/uri-list"];
        var i;
        for (i = 0; i < order.length; i++) {
            var t = asText(data[order[i]]);
            if (t && t !== "{}" && t !== "null") return t;
        }
        var keys = [];
        for (var k in data) {
            if (Object.prototype.hasOwnProperty.call(data, k)) keys.push(k);
        }
        for (i = 0; i < keys.length; i++) {
            var t2 = asText(data[keys[i]]);
            if (t2 && t2 !== "{}" && t2 !== "null") return t2;
        }
        return asText(data);
    }

    function b64ToBytes(b64) {
        var bin = atob(b64);
        var out = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }

    function decodeCin2(bytes) {
        if (bytes.length < 48) throw new Error("2cin blob too short");
        var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        var magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
        if (magic !== "2cin") throw new Error("Unknown FourCC " + magic);
        var count = view.getUint32(12, true);
        var verts = [];
        for (var i = 0; i < count; i++) {
            var o = 16 + i * 32;
            verts.push({
                x: view.getFloat32(o + 4, true),
                y: view.getFloat32(o + 8, true),
                inX: view.getFloat32(o + 12, true),
                inY: view.getFloat32(o + 16, true),
                outX: view.getFloat32(o + 20, true),
                outY: view.getFloat32(o + 24, true),
            });
        }
        return { vertices: verts };
    }

    function cubic(a, b, c, d, t) {
        var u = 1 - t;
        return {
            x: u * u * u * a.x + 3 * u * u * t * b.x + 3 * u * t * t * c.x + t * t * t * d.x,
            y: u * u * u * a.y + 3 * u * u * t * b.y + 3 * u * t * t * c.y + t * t * t * d.y,
        };
    }

    function sampleShape(shape) {
        var v = shape.vertices;
        var pts = [];
        for (var i = 0; i < v.length; i++) {
            var a = v[i];
            var b = v[(i + 1) % v.length];
            for (var s = 0; s < 8; s++) {
                pts.push(
                    cubic(
                        { x: a.x, y: a.y },
                        { x: a.outX, y: a.outY },
                        { x: b.inX, y: b.inY },
                        { x: b.x, y: b.y },
                        s / 8,
                    ),
                );
            }
        }
        return pts;
    }

    function centroid(pts) {
        var sx = 0;
        var sy = 0;
        for (var i = 0; i < pts.length; i++) {
            sx += pts[i].x;
            sy += pts[i].y;
        }
        var n = Math.max(pts.length, 1);
        return { x: sx / n, y: sy / n };
    }

    function stats(shape, w, h) {
        var pts = sampleShape(shape).map(function (p) {
            return { x: p.x * w, y: p.y * h };
        });
        var c = centroid(pts);
        var xx = 0;
        var yy = 0;
        var xy = 0;
        var minX = Infinity;
        var maxX = -Infinity;
        var minY = Infinity;
        var maxY = -Infinity;
        var i;
        for (i = 0; i < pts.length; i++) {
            var dx = pts[i].x - c.x;
            var dy = pts[i].y - c.y;
            xx += dx * dx;
            yy += dy * dy;
            xy += dx * dy;
        }
        var n = Math.max(pts.length, 1);
        var ang = 0.5 * Math.atan2(2 * (xy / n), xx / n - yy / n);
        var cos = Math.cos(-ang);
        var sin = Math.sin(-ang);
        for (i = 0; i < pts.length; i++) {
            var lx = (pts[i].x - c.x) * cos - (pts[i].y - c.y) * sin;
            var ly = (pts[i].x - c.x) * sin + (pts[i].y - c.y) * cos;
            if (lx < minX) minX = lx;
            if (lx > maxX) maxX = lx;
            if (ly < minY) minY = ly;
            if (ly > maxY) maxY = ly;
        }
        return { c: c, ang: ang, ex: Math.max(maxX - minX, 1e-6), ey: Math.max(maxY - minY, 1e-6) };
    }

    function unwrap(deg) {
        var out = [deg[0] || 0];
        for (var i = 1; i < deg.length; i++) {
            var d = deg[i];
            var prev = out[i - 1];
            while (d - prev > 180) d -= 360;
            while (d - prev < -180) d += 360;
            out.push(d);
        }
        return out;
    }

    function solveFollow(keys, w, h) {
        if (!keys.length) return [];
        var ref = stats(keys[0].shape, w, h);
        var raw = [];
        var drafts = keys.map(function (kf) {
            var s = stats(kf.shape, w, h);
            raw.push((s.ang * 180) / Math.PI);
            return { kf: kf, s: s };
        });
        var un = unwrap(raw);
        return drafts.map(function (d, i) {
            var sx = (d.s.ex / ref.ex) * 100;
            var sy = (d.s.ey / ref.ey) * 100;
            return {
                ticks: d.kf.ticks,
                x: d.s.c.x,
                y: d.s.c.y,
                scale: (sx + sy) / 2,
                rotation: un[i] - un[0],
            };
        });
    }

    function invert(follow) {
        if (!follow.length) return [];
        var r = follow[0];
        return follow.map(function (s) {
            return {
                ticks: s.ticks,
                seq: s.seq,
                x: r.x - (s.x - r.x),
                y: r.y - (s.y - r.y),
                scale: s.scale === 0 ? 100 : (r.scale / s.scale) * 100,
                rotation: r.rotation - s.rotation,
            };
        });
    }

    // Turn decoded mask shapes into follow-samples (sorted, times relative to the first shape)
    function samplesFromShapes(keys, label) {
        var sorted = keys.slice().sort(function (a, b) { return a.ticks - b.ticks; });
        var t0 = sorted[0].ticks;
        var rel = sorted.map(function (k) { return { ticks: k.ticks - t0, shape: k.shape }; });
        return {
            samples: solveFollow(rel, 1920, 1080),
            detail: label + " · " + rel.length + " shapes",
            unit: "px",
            size: { w: 1920, h: 1080 },
        };
    }

    function parseCin2List(text) {
        var chunks = text.split(";").map(function (s) { return String(s).trim(); }).filter(Boolean);
        var keys = [];
        for (var i = 0; i < chunks.length; i++) {
            var comma = chunks[i].indexOf(",");
            if (comma < 0) continue;
            var tk = Number(chunks[i].slice(0, comma));
            if (!isFinite(tk)) continue;
            var b64 = chunks[i].slice(comma + 1).replace(/\s+/g, "");
            try {
                keys.push({
                    ticks: tk,
                    shape: decodeCin2(b64ToBytes(b64)),
                });
            } catch (e) {}
        }
        return keys;
    }

    // Fallback: find 2cin blobs anywhere in the text, with or without leading times
    function scanCin2(text) {
        var flat = String(text).replace(/\s+/g, "");
        var keys = [];
        var m;
        var re = /(-?\d+),(MmNpbg[A-Za-z0-9+\/]*={0,2})/g;
        while ((m = re.exec(flat))) {
            try {
                keys.push({ ticks: Number(m[1]), shape: decodeCin2(b64ToBytes(m[2])) });
            } catch (e) {}
        }
        if (!keys.length) {
            var re2 = /MmNpbg[A-Za-z0-9+\/]*={0,2}/g;
            var i = 0;
            while ((m = re2.exec(flat))) {
                try {
                    keys.push({ ticks: i * Math.round(TICKS / 24), shape: decodeCin2(b64ToBytes(m[0])) });
                    i++;
                } catch (e2) {}
            }
        }
        return keys;
    }

    function extractKeyframesXml(raw) {
        var m = raw.match(/<Keyframes[^>]*>([\s\S]*?)<\/Keyframes>/i);
        if (m && m[1]) return m[1].trim();
        m = raw.match(/(-?\d+\s*,\s*[A-Za-z0-9+/=]{20,}(?:;\s*-?\d+\s*,\s*[A-Za-z0-9+/=]{20,})*;?)/);
        if (m) return m[1];
        return null;
    }

    function parseJsonKeys(text) {
        var data = JSON.parse(text);
        var rows = Array.isArray(data) ? data : data && data.keys;
        if (!Array.isArray(rows) || !rows.length) throw new Error("JSON has no keys");
        return rows.map(function (row, i) {
            row = row || {};
            var pos = row.position || {};
            var sec = Number(row.t != null ? row.t : row.time != null ? row.time : i / 24);
            return {
                ticks: Math.round(sec * TICKS),
                x: Number(row.x != null ? row.x : pos.x || 0),
                y: Number(row.y != null ? row.y : pos.y || 0),
                scale: Number(row.scale != null ? row.scale : 100),
                rotation: Number(row.rotation != null ? row.rotation : 0),
            };
        });
    }

    function takeEvery(items, n) {
        var step = Math.max(1, n | 0);
        if (step === 1 || items.length <= 2) return items.slice();
        var out = [];
        for (var i = 0; i < items.length; i += step) out.push(items[i]);
        if (out[out.length - 1] !== items[items.length - 1]) out.push(items[items.length - 1]);
        return out;
    }

    function ingest(input) {
        var raw = asText(input).replace(/\u0000/g, "").replace(/^\uFEFF/, "").trim();
        if (!raw) throw new Error("Nothing to load.");
        var xmlKeys = extractKeyframesXml(raw);
        if (xmlKeys) raw = xmlKeys;
        if (/^-?\d+\s*,/.test(raw) || raw.indexOf("MmNpbg") >= 0) {
            var keys = parseCin2List(raw);
            if (!keys.length) keys = scanCin2(raw);
            if (!keys.length) throw new Error("No 2cin keys found.");
            return samplesFromShapes(keys, "Mask path");
        }
        if (raw.charAt(0) === "[" || raw.charAt(0) === "{") {
            try {
                var json = parseJsonKeys(raw);
                return { samples: json, detail: "Object tracking keys · " + json.length };
            } catch (e) {
                throw new Error("Clipboard is not mask path or JSON keys.");
            }
        }
        throw new Error("Clipboard is not mask path text. Use Read selected clip.");
    }

    function planned() {
        var src = state.samples.slice();
        var samples = state.mode === "stabilize" ? invert(src) : src;
        return takeEvery(samples, state.everyNth);
    }

    function refreshPlan() {
        $("plan-status").textContent = planned().length + " keys ready";
        $("nth-val").textContent = String(state.everyNth);
    }

    // Premiere Position values are normalized (0..1); pixel values are in the hundreds/thousands.
    function looksNormalized(samples) {
        if (!samples || !samples.length) return false;
        for (var i = 0; i < samples.length; i++) {
            if (Math.abs(samples[i].x) > 4 || Math.abs(samples[i].y) > 4) return false;
        }
        return true;
    }

    function motionSummary(samples, unit) {
        var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        var minS = Infinity, maxS = -Infinity, minR = Infinity, maxR = -Infinity;
        for (var i = 0; i < samples.length; i++) {
            var q = samples[i];
            if (q.x < minX) minX = q.x;
            if (q.x > maxX) maxX = q.x;
            if (q.y < minY) minY = q.y;
            if (q.y > maxY) maxY = q.y;
            if (q.scale < minS) minS = q.scale;
            if (q.scale > maxS) maxS = q.scale;
            if (q.rotation < minR) minR = q.rotation;
            if (q.rotation > maxR) maxR = q.rotation;
        }
        var thr = unit === "norm" ? 5e-5 : 0.05;
        var dx = samples.length ? maxX - minX : 0;
        var dy = samples.length ? maxY - minY : 0;
        return {
            dx: dx,
            dy: dy,
            moveX: dx > thr,
            moveY: dy > thr,
            moveScale: samples.length ? maxS - minS > 0.01 : false,
            moveRot: samples.length ? maxR - minR > 0.01 : false,
        };
    }

    function saveCache(detail) {
        try {
            localStorage.setItem(
                "keypath.cache",
                JSON.stringify({ samples: state.samples, unit: state.srcUnit, size: state.srcSize, detail: detail })
            );
        } catch (e) {}
    }

    function restoreCache() {
        try {
            var raw = localStorage.getItem("keypath.cache");
            if (!raw) return;
            var c = JSON.parse(raw);
            if (c && c.samples && c.samples.length) {
                loadSamples(c.samples, (c.detail || "Cache") + " (restored)", c.unit, c.size, true);
            }
        } catch (e) {}
    }

    // How much the tracked mask changes at each keyframe (vs the previous one)
    function deltaBox() {
        var el = $("deltas");
        if (el) return el;
        try {
            el = document.createElement("pre");
            el.id = "deltas";
            el.style.fontSize = "10px";
            el.style.margin = "6px 0 0";
            el.style.overflow = "auto";
            var anchor = $("load-status");
            if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(el, anchor.nextSibling);
            return el;
        } catch (e) {
            return null;
        }
    }

    function fmt(n, d) {
        var v = Number(n);
        if (!isFinite(v)) return "0";
        return (v >= 0 ? "+" : "") + v.toFixed(d);
    }

    function showDeltas(samples, unit) {
        var box = deltaBox();
        if (!samples || samples.length < 2) {
            if (box) box.textContent = "";
            return;
        }
        var d = unit === "norm" ? 4 : 1;
        var rows = ["key   time     Δx       Δy      Δscale%  Δrot°"];
        var all = [];
        for (var i = 0; i < samples.length; i++) {
            var q = samples[i];
            var pv = i ? samples[i - 1] : q;
            var line =
                String(i).padEnd(5) + " " +
                (q.ticks / TICKS).toFixed(2).padEnd(7) + "s " +
                fmt(q.x - pv.x, d).padEnd(8) + " " +
                fmt(q.y - pv.y, d).padEnd(8) + " " +
                fmt(q.scale - pv.scale, 2).padEnd(8) + " " +
                fmt(q.rotation - pv.rotation, 2);
            all.push(line);
        }
        var shown = all.length > 12 ? all.slice(0, 8).concat(["  …"], all.slice(-3)) : all;
        var first = samples[0];
        var last = samples[samples.length - 1];
        var total =
            "total  Δx " + fmt(last.x - first.x, d) + "  Δy " + fmt(last.y - first.y, d) +
            "  Δscale " + fmt(last.scale - first.scale, 2) + "%  Δrot " + fmt(last.rotation - first.rotation, 2) + "°";
        console.log("KEYPATH change per keyframe\n" + rows.concat(shown, [total]).join("\n"));
        if (box) box.textContent = rows.concat(shown, [total]).join("\n");
    }

    function loadSamples(samples, detail, unit, size, noSave) {
        state.samples = samples;
        state.srcUnit = unit || (looksNormalized(samples) ? "norm" : "px");
        state.srcSize = size || null;
        var mo = motionSummary(samples, state.srcUnit);
        var digits = state.srcUnit === "norm" ? 4 : 1;
        var label =
            detail +
            (state.srcUnit === "norm" ? " · normalized" : " · px") +
            " · Δx " + mo.dx.toFixed(digits) + " Δy " + mo.dy.toFixed(digits);
        $("load-status").textContent = label;
        refreshPlan();
        if (!mo.moveX && !mo.moveY && !mo.moveScale && !mo.moveRot) {
            setResult(
                label + " — the loaded data has NO motion. For mask tracking, select the Mask Path property in Effect Controls, copy it (Ctrl/Cmd+C) and use Read clipboard.",
                "bad"
            );
        } else {
            setResult(label, "ok");
        }
        showDeltas(samples, state.srcUnit);
        if (!noSave) saveCache(detail);
    }

    function tickSeconds(t) {
        if (!t) return 0;
        if (typeof t.seconds === "number") return t.seconds;
        if (typeof t.getSeconds === "function") return t.getSeconds();
        if (t.ticks != null) return Number(t.ticks) / TICKS;
        return 0;
    }

    async function maybe(fn) {
        try {
            var v = typeof fn === "function" ? fn() : fn;
            return await Promise.resolve(v);
        } catch (e) {
            return null;
        }
    }

    function unpackPoint(v) {
        if (v == null) return null;
        if (typeof v.x === "number" && typeof v.y === "number") return { x: v.x, y: v.y };
        var inner = v.value != null ? v.value : v;
        if (inner && typeof inner.x === "number") return { x: inner.x, y: inner.y };
        if (Array.isArray(inner) && inner.length >= 2) return { x: Number(inner[0]), y: Number(inner[1]) };
        if (inner && Array.isArray(inner.value) && inner.value.length >= 2) {
            return { x: Number(inner.value[0]), y: Number(inner.value[1]) };
        }
        return null;
    }

    function unpackNum(v) {
        if (typeof v === "number") return v;
        if (v && typeof v.value === "number") return v.value;
        if (v && v.value && typeof v.value.value === "number") return v.value.value;
        var n = Number(v);
        return isFinite(n) ? n : 0;
    }

    async function getSelectedClip(ppro) {
        var project = await ppro.Project.getActiveProject();
        if (!project) throw new Error("No active project.");
        var sequence = await project.getActiveSequence();
        if (!sequence) throw new Error("No active sequence.");
        var selection = await sequence.getSelection();
        var items = await selection.getTrackItems();
        if ((!items || !items.length) && typeof selection.getTrackItems === "function") {
            try {
                items = await selection.getTrackItems(1, false);
            } catch (e) {}
        }
        var clip = null;
        for (var i = 0; i < (items || []).length; i++) {
            if (typeof items[i].getComponentChain === "function") {
                clip = items[i];
                break;
            }
        }
        if (!clip) throw new Error("Select the target text/graphic clip in the timeline.");
        return { project: project, sequence: sequence, clip: clip };
    }

    async function getFrameSize(sequence) {
        var r = await maybe(function () { return sequence.getFrameSize(); });
        if (r && r.width > 0 && r.height > 0) return { w: r.width, h: r.height };
        var st = await maybe(function () { return sequence.getSettings(); });
        if (st) {
            var vr = await maybe(function () { return st.getVideoFrameRect(); });
            if (vr && vr.width > 0 && vr.height > 0) return { w: vr.width, h: vr.height };
        }
        return { w: 1920, h: 1080 };
    }

    async function listParams(comp) {
        var n = await comp.getParamCount();
        var out = [];
        for (var i = 0; i < n; i++) out.push(await comp.getParam(i));
        return out;
    }

    var MAX_SAMPLES = 80;

    function skipComp(dname, match) {
        var s = ((dname || "") + " " + (match || "")).toLowerCase();
        return /opacity|time remap|volume|lumetri|audio|transition|channel/.test(s);
    }

    function likelyTrack(dname, match) {
        var s = ((dname || "") + " " + (match || "")).toLowerCase();
        return /transform|motion|mask|ellipse|geometry|crop|corner/.test(s);
    }

    function thinList(list, maxN) {
        if (!list || !list.length) return [];
        if (list.length <= maxN) return list.slice();
        var out = [];
        var last = list.length - 1;
        var step = last / (maxN - 1);
        var prev = -1;
        for (var i = 0; i < maxN; i++) {
            var idx = Math.round(i * step);
            if (idx === prev) continue;
            out.push(list[idx]);
            prev = idx;
        }
        if (out[out.length - 1] !== list[last]) out.push(list[last]);
        return out;
    }

    function yieldTick() {
        return new Promise(function (resolve) {
            setTimeout(resolve, 0);
        });
    }

    async function findPsr(comp) {
        var n = await comp.getParamCount();
        var pos = null;
        var sc = null;
        var rot = null;
        for (var i = 0; i < n; i++) {
            var p = await comp.getParam(i);
            var dn = (p.displayName || "").toLowerCase();
            if (dn === "position") pos = p;
            else if (dn === "scale" || dn === "scale height") sc = p;
            else if (dn === "rotation") rot = p;
        }
        return { pos: pos, sc: sc, rot: rot };
    }

    async function keyTimes(param) {
        var list = await maybe(function () {
            return param.getKeyframeListAsTickTimes();
        });
        return list && list.length ? list : [];
    }

    async function readPoint(param, tt) {
        var kf = await maybe(function () {
            return param.getKeyframePtr(tt);
        });
        if (kf) {
            var packed = unpackPoint(kf.value != null ? kf.value : kf);
            if (packed) return packed;
        }
        return unpackPoint(await param.getValueAtTime(tt));
    }

    function ticksOf(t) {
        if (t == null) return 0;
        try {
            if (typeof t.ticks === "string") return Number(t.ticks) || 0;
            if (typeof t.ticks === "number") return t.ticks;
        } catch (e) {}
        try {
            if (typeof t.seconds === "number") return Math.round(t.seconds * TICKS);
        } catch (e2) {}
        var n = Number(t);
        return isFinite(n) ? n : 0;
    }

    function describeValue(v) {
        if (v == null) return String(v);
        var t = typeof v;
        if (t === "string") return "string(" + v.length + ") \"" + v.slice(0, 10) + "\"";
        if (t !== "object") return t;
        var ctor = v.constructor && v.constructor.name ? v.constructor.name : "object";
        if (v.byteLength != null) return ctor + "(" + v.byteLength + " bytes)";
        var keys = [];
        try { keys = Object.keys(v).slice(0, 6); } catch (e) {}
        return ctor + "{" + keys.join(",") + "}";
    }

    function numOr(v, d) {
        var n = Number(v);
        return isFinite(n) ? n : d;
    }

    // Try every representation a mask-path value could come back in and return a decoded shape (or null)
    function valueToShape(v, depth) {
        depth = depth || 0;
        if (v == null || depth > 3) return null;
        try {
            if (typeof v === "string") {
                var str = v.trim();
                var comma = str.indexOf(",");
                if (comma > 0 && comma < 24 && /^-?\d+$/.test(str.slice(0, comma).trim())) {
                    str = str.slice(comma + 1).trim();
                }
                if (/^[A-Za-z0-9+/=\s]{40,}$/.test(str)) {
                    return decodeCin2(b64ToBytes(str.replace(/\s+/g, "")));
                }
                return null;
            }
            if (typeof ArrayBuffer !== "undefined") {
                if (v instanceof ArrayBuffer) return decodeCin2(new Uint8Array(v));
                if (ArrayBuffer.isView(v)) return decodeCin2(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
            }
            if (Array.isArray(v.vertices) && v.vertices.length) {
                return {
                    vertices: v.vertices.map(function (q) {
                        var x = numOr(q.x, 0);
                        var y = numOr(q.y, 0);
                        return {
                            x: x,
                            y: y,
                            inX: numOr(q.inX, x),
                            inY: numOr(q.inY, y),
                            outX: numOr(q.outX, x),
                            outY: numOr(q.outY, y),
                        };
                    }),
                };
            }
            if (v.value != null) return valueToShape(v.value, depth + 1);
        } catch (e) {
            return null;
        }
        return null;
    }

    async function getTicksPerFrame(sequence) {
        var tb = await maybe(function () { return sequence.getTimebase(); });
        var n = Number(tb);
        if (isFinite(n) && n > 0) return n;
        var st = await maybe(function () { return sequence.getSettings(); });
        if (st) {
            var fr = await maybe(function () { return st.getVideoFrameRate(); });
            if (fr) {
                var tpf = Number(fr.ticksPerFrame);
                if (isFinite(tpf) && tpf > 0) return tpf;
                var fps = Number(fr.value);
                if (isFinite(fps) && fps > 0) return Math.round(TICKS / fps);
            }
        }
        return Math.round(TICKS / 24);
    }

    var MASK_MAX_FRAMES = 600;

    async function numAt(param, tt, dflt) {
        if (!param) return dflt;
        var v = await maybe(function () { return param.getValueAtTime(tt); });
        return v == null ? dflt : unpackNum(v);
    }

    // Reads mask-path keyframes directly from the selected clip's effects (no clipboard).
    async function readMaskFromClip(ppro, host, diag) {
        var chain = await host.clip.getComponentChain();
        var count = await chain.getComponentCount();
        var cands = [];
        var ci, pi;

        setResult("Scanning effects for a mask path…", "muted");
        for (ci = 0; ci < count; ci++) {
            var comp = await chain.getComponentAtIndex(ci);
            var dname = await comp.getDisplayName();
            var match = await comp.getMatchName();
            if (/audio|volume|time remap/i.test(dname + " " + match)) continue;
            var n = await comp.getParamCount();
            var seenNames = [];
            for (pi = 0; pi < n; pi++) {
                var prm = await comp.getParam(pi);
                var pname = prm.displayName || "";
                if (seenNames.length < 20) seenNames.push(pname || "(unnamed)");
                // New mask UI labels the property just "Path"; older builds use "Mask Path"
                if (!/mask|path/i.test(pname)) continue;
                var tl = await keyTimes(prm);
                var tv = await maybe(function () { return prm.isTimeVarying(); });
                diag.lines.push(dname + " › " + pname + ": " + tl.length + " keys" + (tv ? ", animated" : ""));
                if (tl.length >= 1 || tv === true) cands.push({ dname: dname, pname: pname, prm: prm, times: tl });
            }
            diag.names.push(dname + " [" + seenNames.join(", ") + (n > seenNames.length ? ", …" : "") + "]");
            if (ci % 3 === 2) await yieldTick();
        }

        if (!cands.length) {
            diag.note = "no keyframed Mask Path parameter is exposed on this clip";
            return null;
        }
        cands.sort(function (a, b) { return b.times.length - a.times.length; });

        var tpf = await getTicksPerFrame(host.sequence);
        var startTicks = Math.round(ticksOf(await host.clip.getInPoint()));
        var durTicks = Math.round(ticksOf(await host.clip.getDuration()));

        for (var c = 0; c < cands.length; c++) {
            var cand = cands[c];
            var t0 = startTicks;
            var span = durTicks;
            if (span <= 0 && cand.times.length >= 2) {
                t0 = Math.round(ticksOf(cand.times[0]));
                span = Math.round(ticksOf(cand.times[cand.times.length - 1])) - t0;
            }
            var frames = span > 0 ? Math.floor(span / tpf) + 1 : 0;
            if (frames < 2) {
                diag.note = cand.pname + ": could not work out the clip's frame range";
                continue;
            }
            var stride = Math.max(1, Math.ceil(frames / MASK_MAX_FRAMES));
            var keys = [];
            var seen = "";
            var tried = 0;

            // READ & CACHE: sample the path on every frame — tracker data is not always stored as keyframes
            for (var f = 0; f < frames; f += stride) {
                if (f && (f / stride) % 10 === 0) {
                    setResult("Reading & caching mask " + f + "/" + frames + " frames…", "muted");
                    await yieldTick();
                }
                var tt = ppro.TickTime.createWithTicks(String(t0 + f * tpf));
                var gv = await maybe(function () { return cand.prm.getValueAtTime(tt); });
                var shape = valueToShape(gv);
                var raw = null;
                if (!shape) {
                    var kf = await maybe(function () { return cand.prm.getKeyframePtr(tt); });
                    raw = kf ? (kf.value != null ? kf.value : kf) : null;
                    shape = valueToShape(raw);
                }
                tried++;
                if (shape && shape.vertices && shape.vertices.length) {
                    keys.push({ ticks: f * tpf, shape: shape });
                } else if (!seen) {
                    seen = describeValue(gv) + " / " + describeValue(raw);
                }
                if (!keys.length && tried >= 6) break; // values are not readable — stop early
            }
            if (keys.length < 2 && cand.times.length >= 2) {
                // fall back to the keyframe times themselves
                keys = [];
                var kt = thinList(cand.times, MAX_SAMPLES);
                for (var q = 0; q < kt.length; q++) {
                    var kp = await maybe(function () { return cand.prm.getKeyframePtr(kt[q]); });
                    var ks = valueToShape(kp ? (kp.value != null ? kp.value : kp) : null);
                    if (!ks) ks = valueToShape(await maybe(function () { return cand.prm.getValueAtTime(kt[q]); }));
                    if (ks && ks.vertices && ks.vertices.length) keys.push({ ticks: ticksOf(kt[q]), shape: ks });
                }
            }
            if (keys.length >= 2) {
                return samplesFromShapes(keys, cand.dname + " › " + cand.pname + " · cached");
            }
            diag.note = cand.pname + " (" + cand.times.length + " keys) values are not readable by the API (" + (seen || "empty") + ")";
        }
        return null;
    }

    // Any animated Position / Scale / Rotation group on ANY effect of the selected clip
    // (Motion, Transform, a tracked mask's Transform, an adjustment layer or matte...). Plain numbers, sampled every frame.
    async function readAnimatedTransform(ppro, host, diag) {
        var chain = await host.clip.getComponentChain();
        var count = await chain.getComponentCount();
        var groups = [];
        var ci, pi;

        setResult("Looking for tracked mask Transform…", "muted");
        for (ci = 0; ci < count; ci++) {
            var comp = await chain.getComponentAtIndex(ci);
            var dname = await comp.getDisplayName();
            var match = await comp.getMatchName();
            if (/audio|volume|time remap/i.test(dname + " " + match)) continue;
            var n = await comp.getParamCount();
            var cur = null;
            for (pi = 0; pi < n; pi++) {
                var prm = await comp.getParam(pi);
                var dn = (prm.displayName || "").toLowerCase();
                if (dn === "position") {
                    if (cur && cur.pos) groups.push(cur);
                    if (!cur || cur.pos) cur = { dname: dname, pos: null, sc: null, scw: null, rot: null };
                    cur.pos = prm;
                } else if (cur && (dn === "scale height" || dn === "scale")) {
                    cur.sc = prm;
                } else if (cur && dn === "scale width") {
                    cur.scw = prm;
                } else if (cur && dn === "rotation") {
                    cur.rot = prm;
                }
            }
            if (cur && cur.pos) groups.push(cur);
            if (ci % 3 === 2) await yieldTick();
        }

        var animated = [];
        for (var g = 0; g < groups.length; g++) {
            var grp = groups[g];
            grp.times = await keyTimes(grp.pos);
            var tv = await maybe(function () { return grp.pos.isTimeVarying(); });
            if (tv === true || grp.times.length >= 2) animated.push(grp);
        }
        diag.names.push("TRANSFORM: " + groups.length + " Position group(s), " + animated.length + " animated");
        if (!animated.length) return null;

        animated.sort(function (a, b) { return b.times.length - a.times.length; });
        var best = animated[0];

        var tpf = await getTicksPerFrame(host.sequence);
        var t0 = Math.round(ticksOf(await host.clip.getInPoint()));
        var span = Math.round(ticksOf(await host.clip.getDuration()));
        if (span <= 0 && best.times.length >= 2) {
            t0 = Math.round(ticksOf(best.times[0]));
            span = Math.round(ticksOf(best.times[best.times.length - 1])) - t0;
        }
        var frames = span > 0 ? Math.floor(span / tpf) + 1 : 0;
        if (frames < 2) {
            diag.names.push("TRANSFORM: could not work out the clip's frame range");
            return null;
        }
        var stride = Math.max(1, Math.ceil(frames / MASK_MAX_FRAMES));

        var samples = [];
        var misses = 0;
        for (var f = 0; f < frames; f += stride) {
            if (f && (f / stride) % 10 === 0) {
                setResult("Reading & caching mask Transform " + f + "/" + frames + " frames…", "muted");
                await yieldTick();
            }
            var tt = ppro.TickTime.createWithTicks(String(t0 + f * tpf));
            var pv = unpackPoint(await maybe(function () { return best.pos.getValueAtTime(tt); }));
            if (!pv) {
                misses++;
                if (!samples.length && misses >= 6) break;
                continue;
            }
            var sh = await numAt(best.sc, tt, 100);
            var sw = best.scw ? await numAt(best.scw, tt, sh) : sh;
            samples.push({
                ticks: f * tpf,
                x: pv.x,
                y: pv.y,
                scale: (sh + sw) / 2,
                rotation: await numAt(best.rot, tt, 0),
            });
        }
        if (samples.length < 2) {
            diag.names.push("TRANSFORM: Position values were not readable");
            return null;
        }
        return {
            samples: samples,
            detail: best.dname + " › Position/Scale/Rotation · cached · " + samples.length + " frames",
        };
    }


    function showDiag(diag) {
        var box = deltaBox();
        var lines = ["SCAN — what the API exposes on this clip:"]
            .concat(diag.names, diag.lines, diag.note ? ["note: " + diag.note] : []);
        console.log("KEYPATH scan", lines.join("\n"));
        if (box) box.textContent = lines.join("\n");
    }

    // Real data only — nothing is simulated. Sources, in order:
    //  1) an animated Position/Scale/Rotation group on any effect (tracked mask Transform, Motion/Transform of an adjustment layer or matte)
    //  2) the mask Path shapes, from which the change per keyframe is calculated
    async function readClipTracking(ppro) {
        var host = await getSelectedClip(ppro);
        var diag = { lines: [], names: [], note: "" };

        var got = await readAnimatedTransform(ppro, host, diag);
        if (got) return got;
        got = await readMaskFromClip(ppro, host, diag);
        if (got) return got;

        showDiag(diag);
        throw new Error(
            "No real motion data could be read from this clip (" + (diag.note || "no animated Position/Scale/Rotation and no readable mask path") + "). " +
            "[scan: " + diag.names.join(" | ").slice(0, 700) + "]"
        );
    }

    /* ================================================================== */
    /* PIXEL TRACKER                                                       */
    /* Exports frames of the sequence, follows the chosen box with        */
    /* template matching and calculates position / scale / rotation.      */
    /* Nothing is simulated: every value comes from the exported pixels.  */
    /* ================================================================== */

    /* ---------- PNG decoding (pure JS: no canvas / Image needed) ---------- */

    var LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
    var LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
    var DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
    var DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
    var CLORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
    var FIXED_TABLES = null;

    function buildHuff(lengths, n) {
        var count = new Uint16Array(16);
        var symbol = new Uint16Array(n);
        var offs = new Uint16Array(16);
        var i;
        for (i = 0; i < n; i++) count[lengths[i]]++;
        for (i = 1; i < 15; i++) offs[i + 1] = offs[i] + count[i];
        for (i = 0; i < n; i++) {
            if (lengths[i] !== 0) symbol[offs[lengths[i]]++] = i;
        }
        return { count: count, symbol: symbol };
    }

    function fixedTables() {
        if (FIXED_TABLES) return FIXED_TABLES;
        var l = new Uint8Array(288);
        var i;
        for (i = 0; i < 144; i++) l[i] = 8;
        for (; i < 256; i++) l[i] = 9;
        for (; i < 280; i++) l[i] = 7;
        for (; i < 288; i++) l[i] = 8;
        var d = new Uint8Array(30);
        for (i = 0; i < 30; i++) d[i] = 5;
        FIXED_TABLES = { lit: buildHuff(l, 288), dist: buildHuff(d, 30) };
        return FIXED_TABLES;
    }

    // Raw DEFLATE decoder (RFC 1951) starting at byte offset `start` of `src`
    function inflate(src, start) {
        var pos = start;
        var bitBuf = 0;
        var bitCnt = 0;
        var out = new Uint8Array(Math.max(4096, src.length * 3));
        var op = 0;

        function bits(n) {
            while (bitCnt < n) {
                if (pos >= src.length) throw new Error("inflate: out of data");
                bitBuf |= src[pos++] << bitCnt;
                bitCnt += 8;
            }
            var v = bitBuf & ((1 << n) - 1);
            bitBuf >>>= n;
            bitCnt -= n;
            return v;
        }

        function decode(h) {
            var code = 0;
            var first = 0;
            var index = 0;
            for (var len = 1; len <= 15; len++) {
                code |= bits(1);
                var count = h.count[len];
                if (code - count < first) return h.symbol[index + (code - first)];
                index += count;
                first += count;
                first <<= 1;
                code <<= 1;
            }
            throw new Error("inflate: bad code");
        }

        function need(k) {
            if (op + k > out.length) {
                var bigger = new Uint8Array(Math.max(out.length * 2, op + k));
                bigger.set(out.subarray(0, op));
                out = bigger;
            }
        }

        var last;
        do {
            last = bits(1);
            var type = bits(2);
            if (type === 0) {
                bitBuf = 0;
                bitCnt = 0;
                var len0 = src[pos] | (src[pos + 1] << 8);
                pos += 4;
                need(len0);
                out.set(src.subarray(pos, pos + len0), op);
                op += len0;
                pos += len0;
            } else if (type === 1 || type === 2) {
                var lit;
                var dist;
                if (type === 1) {
                    var fx = fixedTables();
                    lit = fx.lit;
                    dist = fx.dist;
                } else {
                    var nlen = bits(5) + 257;
                    var ndist = bits(5) + 1;
                    var ncode = bits(4) + 4;
                    var cl = new Uint8Array(19);
                    var i;
                    for (i = 0; i < ncode; i++) cl[CLORDER[i]] = bits(3);
                    var lencode = buildHuff(cl, 19);
                    var ll = new Uint8Array(nlen + ndist);
                    var idx = 0;
                    while (idx < nlen + ndist) {
                        var sym0 = decode(lencode);
                        if (sym0 < 16) {
                            ll[idx++] = sym0;
                        } else {
                            var prevLen = 0;
                            var rep;
                            if (sym0 === 16) {
                                if (idx === 0) throw new Error("inflate: bad repeat");
                                prevLen = ll[idx - 1];
                                rep = 3 + bits(2);
                            } else if (sym0 === 17) {
                                rep = 3 + bits(3);
                            } else {
                                rep = 11 + bits(7);
                            }
                            if (idx + rep > nlen + ndist) throw new Error("inflate: bad lengths");
                            while (rep--) ll[idx++] = prevLen;
                        }
                    }
                    lit = buildHuff(ll.subarray(0, nlen), nlen);
                    dist = buildHuff(ll.subarray(nlen), ndist);
                }
                for (;;) {
                    var sym = decode(lit);
                    if (sym < 256) {
                        need(1);
                        out[op++] = sym;
                    } else if (sym === 256) {
                        break;
                    } else {
                        sym -= 257;
                        if (sym >= 29) throw new Error("inflate: bad length symbol");
                        var l = LBASE[sym] + bits(LEXT[sym]);
                        var ds = decode(dist);
                        if (ds >= 30) throw new Error("inflate: bad distance symbol");
                        var d = DBASE[ds] + bits(DEXT[ds]);
                        if (d > op) throw new Error("inflate: distance too far");
                        need(l);
                        for (var k = 0; k < l; k++) {
                            out[op] = out[op - d];
                            op++;
                        }
                    }
                }
            } else {
                throw new Error("inflate: bad block type");
            }
        } while (!last);
        return out.subarray(0, op);
    }

    function readU32(b, o) {
        return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
    }

    // Decodes a PNG into 8-bit luma. Supports grey / RGB / palette / alpha variants, 8 or 16 bit, non-interlaced.
    function decodePng(bytes) {
        if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8) {
            throw new Error("the frame was exported as JPEG — PNG is required");
        }
        if (bytes.length < 8 || bytes[0] !== 137 || bytes[1] !== 80 || bytes[2] !== 78 || bytes[3] !== 71) {
            throw new Error("exported frame is not a PNG (" + bytes.length + " bytes)");
        }
        var pos = 8;
        var w = 0, h = 0, depth = 0, ctype = 0, interlace = 0;
        var plte = null;
        var idat = [];
        var total = 0;
        while (pos + 8 <= bytes.length) {
            var len = readU32(bytes, pos);
            var type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
            var dpos = pos + 8;
            if (type === "IHDR") {
                w = readU32(bytes, dpos);
                h = readU32(bytes, dpos + 4);
                depth = bytes[dpos + 8];
                ctype = bytes[dpos + 9];
                interlace = bytes[dpos + 12];
            } else if (type === "PLTE") {
                plte = bytes.subarray(dpos, dpos + len);
            } else if (type === "IDAT") {
                idat.push(bytes.subarray(dpos, dpos + len));
                total += len;
            } else if (type === "IEND") {
                break;
            }
            pos = dpos + len + 4;
        }
        if (!w || !h || !idat.length) throw new Error("PNG has no image data");
        if (interlace) throw new Error("interlaced PNG is not supported");
        if (depth !== 8 && depth !== 16) throw new Error("PNG bit depth " + depth + " is not supported");

        var merged = new Uint8Array(total);
        var mo = 0;
        for (var c = 0; c < idat.length; c++) {
            merged.set(idat[c], mo);
            mo += idat[c].length;
        }
        var z = inflate(merged, 2);

        var channels = ctype === 0 ? 1 : ctype === 2 ? 3 : ctype === 3 ? 1 : ctype === 4 ? 2 : ctype === 6 ? 4 : 0;
        if (!channels) throw new Error("PNG colour type " + ctype + " is not supported");
        var bpp = channels * (depth >> 3);
        var stride = w * bpp;
        if (z.length < h * (stride + 1)) throw new Error("PNG data is truncated");

        var raw = new Uint8Array(h * stride);
        var x, y;
        for (y = 0; y < h; y++) {
            var ft = z[y * (stride + 1)];
            var s0 = y * (stride + 1) + 1;
            var d0 = y * stride;
            var p0 = d0 - stride;
            if (ft === 0) {
                for (x = 0; x < stride; x++) raw[d0 + x] = z[s0 + x];
            } else if (ft === 1) {
                for (x = 0; x < stride; x++) raw[d0 + x] = (z[s0 + x] + (x >= bpp ? raw[d0 + x - bpp] : 0)) & 255;
            } else if (ft === 2) {
                for (x = 0; x < stride; x++) raw[d0 + x] = (z[s0 + x] + (y > 0 ? raw[p0 + x] : 0)) & 255;
            } else if (ft === 3) {
                for (x = 0; x < stride; x++) {
                    var a3 = x >= bpp ? raw[d0 + x - bpp] : 0;
                    var b3 = y > 0 ? raw[p0 + x] : 0;
                    raw[d0 + x] = (z[s0 + x] + ((a3 + b3) >> 1)) & 255;
                }
            } else if (ft === 4) {
                for (x = 0; x < stride; x++) {
                    var a4 = x >= bpp ? raw[d0 + x - bpp] : 0;
                    var b4 = y > 0 ? raw[p0 + x] : 0;
                    var c4 = x >= bpp && y > 0 ? raw[p0 + x - bpp] : 0;
                    var pp = a4 + b4 - c4;
                    var pa = Math.abs(pp - a4);
                    var pb = Math.abs(pp - b4);
                    var pc = Math.abs(pp - c4);
                    var pr = pa <= pb && pa <= pc ? a4 : pb <= pc ? b4 : c4;
                    raw[d0 + x] = (z[s0 + x] + pr) & 255;
                }
            } else {
                throw new Error("PNG filter " + ft + " is not valid");
            }
        }

        var luma = new Uint8Array(w * h);
        var step = depth >> 3; // bytes per sample (1 or 2); the high byte is kept
        for (y = 0; y < h; y++) {
            for (x = 0; x < w; x++) {
                var i = y * stride + x * bpp;
                var v;
                if (ctype === 0 || ctype === 4) {
                    v = raw[i];
                } else if (ctype === 3) {
                    var pi = raw[i] * 3;
                    v = plte ? 0.299 * plte[pi] + 0.587 * plte[pi + 1] + 0.114 * plte[pi + 2] : raw[i];
                } else {
                    v = 0.299 * raw[i] + 0.587 * raw[i + step] + 0.114 * raw[i + 2 * step];
                }
                luma[y * w + x] = v;
            }
        }
        return { w: w, h: h, luma: luma };
    }

    /* ---------- template tracking ---------- */

    function downsample2(fr) {
        var w2 = fr.w >> 1;
        var h2 = fr.h >> 1;
        var out = new Uint8Array(w2 * h2);
        var L = fr.luma;
        for (var y = 0; y < h2; y++) {
            for (var x = 0; x < w2; x++) {
                var i = 2 * y * fr.w + 2 * x;
                out[y * w2 + x] = (L[i] + L[i + 1] + L[i + fr.w] + L[i + fr.w + 1] + 2) >> 2;
            }
        }
        return { w: w2, h: h2, luma: out };
    }

    function makeTemplate(img, x0, y0, T) {
        var n = T * T;
        var d = new Float32Array(n);
        var s = 0;
        var y, x, i;
        for (y = 0; y < T; y++) {
            for (x = 0; x < T; x++) {
                var v = img.luma[(y0 + y) * img.w + x0 + x];
                d[y * T + x] = v;
                s += v;
            }
        }
        var m = s / n;
        var q = 0;
        for (i = 0; i < n; i++) {
            d[i] -= m;
            q += d[i] * d[i];
        }
        return { T: T, data: d, norm: Math.sqrt(q), std: Math.sqrt(q / n) };
    }

    function halfTemplate(t) {
        var T2 = t.T >> 1;
        var d = new Float32Array(T2 * T2);
        var s = 0;
        var y, x, i;
        for (y = 0; y < T2; y++) {
            for (x = 0; x < T2; x++) {
                var o = 2 * y * t.T + 2 * x;
                var v = (t.data[o] + t.data[o + 1] + t.data[o + t.T] + t.data[o + t.T + 1]) / 4;
                d[y * T2 + x] = v;
                s += v;
            }
        }
        var m = s / (T2 * T2);
        var q = 0;
        for (i = 0; i < d.length; i++) {
            d[i] -= m;
            q += d[i] * d[i];
        }
        return { T: T2, data: d, norm: Math.sqrt(q), std: Math.sqrt(q / d.length) };
    }

    // Zero-mean normalised cross-correlation of template t against img at top-left (x0, y0)
    function znccAt(img, x0, y0, t) {
        var T = t.T;
        if (x0 < 0 || y0 < 0 || x0 + T > img.w || y0 + T > img.h) return -2;
        var sum = 0;
        var sq = 0;
        var dot = 0;
        var L = img.luma;
        var W = img.w;
        var td = t.data;
        for (var y = 0; y < T; y++) {
            var ro = (y0 + y) * W + x0;
            var to = y * T;
            for (var x = 0; x < T; x++) {
                var v = L[ro + x];
                sum += v;
                sq += v * v;
                dot += v * td[to + x];
            }
        }
        var n = T * T;
        var varr = sq - (sum * sum) / n;
        if (varr < 1e-3 || t.norm < 1e-6) return -1;
        return dot / (Math.sqrt(varr) * t.norm);
    }

    function searchBest(img, t, px, py, r) {
        var cx = Math.round(px);
        var cy = Math.round(py);
        var best = -3;
        var bx = cx;
        var by = cy;
        for (var dy = -r; dy <= r; dy++) {
            for (var dx = -r; dx <= r; dx++) {
                var s = znccAt(img, cx + dx, cy + dy, t);
                if (s > best) {
                    best = s;
                    bx = cx + dx;
                    by = cy + dy;
                }
            }
        }
        return { x: bx, y: by, s: best };
    }

    function parabolaOffset(a, b, c) {
        var den = a - 2 * b + c;
        if (!(den < -1e-9)) return 0;
        var o = (a - c) / (2 * den);
        return Math.max(-0.5, Math.min(0.5, o));
    }

    function subpix(img, t, bx, by, s0) {
        var sl = znccAt(img, bx - 1, by, t);
        var sr = znccAt(img, bx + 1, by, t);
        var su = znccAt(img, bx, by - 1, t);
        var sd = znccAt(img, bx, by + 1, t);
        return {
            dx: sl > -1.5 && sr > -1.5 ? parabolaOffset(sl, s0, sr) : 0,
            dy: su > -1.5 && sd > -1.5 ? parabolaOffset(su, s0, sd) : 0,
        };
    }

    // Coarse (half resolution, wide) then fine (full resolution, +-2px) search for one patch
    function trackPatch(img, img2, p, pcx, pcy, R) {
        var T = p.tmpl.T;
        var half = (T - 1) / 2;
        var x0h = Math.round((pcx - half) / 2);
        var y0h = Math.round((pcy - half) / 2);
        var rc = Math.max(2, Math.ceil(R / 2));
        var coarse = searchBest(img2, p.tmpl2, x0h, y0h, rc);
        if (coarse.s < -1.5) return null;
        var fine = searchBest(img, p.tmpl, coarse.x * 2, coarse.y * 2, 2);
        if (fine.s < -1.5) return null;
        var sp = subpix(img, p.tmpl, fine.x, fine.y, fine.s);
        return { x: fine.x + sp.dx + half, y: fine.y + sp.dy + half, score: fine.s, fx: fine.x + sp.dx, fy: fine.y + sp.dy };
    }

    function updateTemplate(p, img, fx, fy, alpha) {
        var T = p.tmpl.T;
        var n = T * T;
        var x0 = Math.floor(fx);
        var y0 = Math.floor(fy);
        var ax = fx - x0;
        var ay = fy - y0;
        if (x0 < 0 || y0 < 0 || x0 + T + 1 > img.w || y0 + T + 1 > img.h) return;
        var L = img.luma;
        var W = img.w;
        var tmp = new Float32Array(n);
        var s = 0;
        var y, x, i;
        for (y = 0; y < T; y++) {
            for (x = 0; x < T; x++) {
                var o = (y0 + y) * W + x0 + x;
                var v = (L[o] * (1 - ax) + L[o + 1] * ax) * (1 - ay) + (L[o + W] * (1 - ax) + L[o + W + 1] * ax) * ay;
                tmp[y * T + x] = v;
                s += v;
            }
        }
        var m = s / n;
        var q = 0;
        for (i = 0; i < n; i++) {
            var nv = (1 - alpha) * p.tmpl.data[i] + alpha * (tmp[i] - m);
            p.tmpl.data[i] = nv;
            q += nv * nv;
        }
        p.tmpl.norm = Math.sqrt(q);
        p.tmpl.std = Math.sqrt(q / n);
        p.tmpl2 = halfTemplate(p.tmpl);
    }

    // Least-squares similarity transform (translation + scale + rotation) from patch observations
    function fitSimilarity(list, prev) {
        var n = list.length;
        var dmx = 0, dmy = 0, qmx = 0, qmy = 0;
        var i;
        for (i = 0; i < n; i++) {
            dmx += list[i].p.dx;
            dmy += list[i].p.dy;
            qmx += list[i].x;
            qmy += list[i].y;
        }
        dmx /= n;
        dmy /= n;
        qmx /= n;
        qmy /= n;
        var a = 0, b = 0, den = 0;
        for (i = 0; i < n; i++) {
            var ddx = list[i].p.dx - dmx;
            var ddy = list[i].p.dy - dmy;
            var qqx = list[i].x - qmx;
            var qqy = list[i].y - qmy;
            a += ddx * qqx + ddy * qqy;
            b += ddx * qqy - ddy * qqx;
            den += ddx * ddx + ddy * ddy;
        }
        var s, th;
        if (n >= 2 && den > 1e-6) {
            a /= den;
            b /= den;
            s = Math.sqrt(a * a + b * b);
            th = Math.atan2(b, a);
            while (th - prev.th > Math.PI) th -= 2 * Math.PI;
            while (th - prev.th < -Math.PI) th += 2 * Math.PI;
            if (s < 0.2 || s > 5) {
                s = prev.s;
                th = prev.th;
                a = s * Math.cos(th);
                b = s * Math.sin(th);
            }
        } else {
            s = prev.s;
            th = prev.th;
            a = s * Math.cos(th);
            b = s * Math.sin(th);
        }
        return { cx: qmx - (a * dmx - b * dmy), cy: qmy - (b * dmx + a * dmy), s: s, th: th, a: a, b: b };
    }

    // region = { cx, cy, size } in frame pixels. Returns a tracker whose step(frame, R) follows the region.
    function createTracker(frame0, region) {
        var S = Math.max(24, region.size);
        var T = Math.max(16, Math.min(40, Math.round(S / 3 / 2) * 2));
        var off = S / 4;
        var offsets = [[0, 0], [-off, -off], [off, -off], [-off, off], [off, off]];
        var patches = [];
        for (var i = 0; i < offsets.length; i++) {
            var x0 = Math.round(region.cx + offsets[i][0] - (T - 1) / 2);
            var y0 = Math.round(region.cy + offsets[i][1] - (T - 1) / 2);
            if (x0 < 0 || y0 < 0 || x0 + T > frame0.w || y0 + T > frame0.h) continue;
            var tm = makeTemplate(frame0, x0, y0, T);
            if (tm.std < 3) continue; // flat area: nothing to lock on to
            patches.push({ dx: x0 + (T - 1) / 2 - region.cx, dy: y0 + (T - 1) / 2 - region.cy, tmpl: tm, tmpl2: halfTemplate(tm) });
        }
        if (!patches.length) {
            throw new Error("the tracking box is outside the frame or has no texture (flat colour) — move it onto a detailed area");
        }
        var st = { cx: region.cx, cy: region.cy, s: 1, th: 0, vx: 0, vy: 0, lost: 0 };

        function step(img, R) {
            var img2 = img.half || (img.half = downsample2(img));
            var cs = Math.cos(st.th) * st.s;
            var sn = Math.sin(st.th) * st.s;
            var pcx = st.cx + st.vx * 0.8;
            var pcy = st.cy + st.vy * 0.8;
            var good = [];
            var j;
            for (j = 0; j < patches.length; j++) {
                var p = patches[j];
                var px = pcx + cs * p.dx - sn * p.dy;
                var py = pcy + sn * p.dx + cs * p.dy;
                var r = trackPatch(img, img2, p, px, py, R);
                if (r && r.score >= 0.5) good.push({ p: p, x: r.x, y: r.y, score: r.score, fx: r.fx, fy: r.fy });
            }
            if (!good.length) {
                st.lost++;
                st.cx = pcx;
                st.cy = pcy;
                st.vx *= 0.5;
                st.vy *= 0.5;
                return { cx: st.cx, cy: st.cy, s: st.s, th: st.th, ok: false, lost: st.lost, used: 0 };
            }
            st.lost = 0;
            var fit = fitSimilarity(good, st);
            if (good.length >= 3) {
                var res = [];
                var k;
                for (k = 0; k < good.length; k++) {
                    var ex = good[k].x - (fit.cx + fit.a * good[k].p.dx - fit.b * good[k].p.dy);
                    var ey = good[k].y - (fit.cy + fit.b * good[k].p.dx + fit.a * good[k].p.dy);
                    res.push(Math.sqrt(ex * ex + ey * ey));
                }
                var sorted = res.slice().sort(function (u, v) { return u - v; });
                var med = sorted[sorted.length >> 1];
                var worst = 0;
                for (k = 1; k < res.length; k++) if (res[k] > res[worst]) worst = k;
                if (res[worst] > 2.5 && res[worst] > 2.5 * med) {
                    good.splice(worst, 1);
                    fit = fitSimilarity(good, st);
                }
            }
            st.vx = fit.cx - st.cx;
            st.vy = fit.cy - st.cy;
            st.cx = fit.cx;
            st.cy = fit.cy;
            st.s = fit.s;
            st.th = fit.th;
            for (j = 0; j < good.length; j++) {
                if (good[j].score > 0.9) updateTemplate(good[j].p, img, good[j].fx, good[j].fy, 0.1);
            }
            return { cx: st.cx, cy: st.cy, s: st.s, th: st.th, ok: true, lost: 0, used: good.length };
        }

        return { step: step, state: st, patchCount: patches.length, patchSize: T };
    }

    /* ---------- frame export ---------- */

    function tryUxpStorage() {
        try {
            return require("uxp").storage;
        } catch (e) {
            return null;
        }
    }

    function sleep(ms) {
        return new Promise(function (resolve) {
            setTimeout(resolve, ms);
        });
    }

    async function makeExportCtx(ppro, seq, w, h) {
        var storage = tryUxpStorage();
        if (!storage || !storage.localFileSystem) throw new Error("UXP file access is not available (needs the localFileSystem permission in manifest.json)");
        if (!ppro.Exporter || typeof ppro.Exporter.exportSequenceFrame !== "function") {
            throw new Error("this Premiere version has no exportSequenceFrame — the pixel tracker cannot get frames");
        }
        var folder = await storage.localFileSystem.getTemporaryFolder();
        var dir = folder.nativePath;
        var sep = String(dir).indexOf("\\") >= 0 ? "\\" : "/";
        var ctx = { ppro: ppro, seq: seq, storage: storage, folder: folder, dir: dir, sep: sep, w: w, h: h, n: 0, variant: null, stamp: String(Date.now()) };
        // clear leftovers from an earlier run
        try {
            var old = await folder.getEntries();
            for (var i = 0; i < old.length; i++) {
                if (old[i].isFile && old[i].name.indexOf("kp_") === 0) await maybe(function () { return old[i].delete(); });
            }
        } catch (e) {}
        return ctx;
    }

    function toBase64(u8) {
        var s = "";
        for (var i = 0; i < u8.length; i += 8192) {
            s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
        }
        return btoa(s);
    }

    // Exports the sequence frame at `ticks` and returns { w, h, luma, bytes }
    async function grabFrame(ctx, ticks) {
        var tt = ctx.ppro.TickTime.createWithTicks(String(Math.round(ticks)));
        var variants = ctx.variant
            ? [ctx.variant]
            : [{ ext: true, sep: false }, { ext: false, sep: false }, { ext: true, sep: true }, { ext: false, sep: true }];
        var found = null;
        var log = [];
        for (var v = 0; v < variants.length && !found; v++) {
            var base = "kp_" + ctx.stamp + "_" + ctx.n++;
            var name = variants[v].ext ? base + ".png" : base;
            var path = variants[v].sep ? ctx.dir + ctx.sep : ctx.dir;
            var ok;
            try {
                ok = await ctx.ppro.Exporter.exportSequenceFrame(ctx.seq, tt, name, path, ctx.w, ctx.h);
            } catch (e) {
                log.push((variants[v].ext ? "name.png" : "name") + (variants[v].sep ? "+sep" : "") + " threw: " + (e && e.message ? e.message : e));
                continue;
            }
            var polls = ok === false ? 4 : 20; // a false return means nothing is being written
            for (var k = 0; k < polls && !found; k++) {
                var entries = await ctx.folder.getEntries();
                for (var e2 = 0; e2 < entries.length; e2++) {
                    if (entries[e2].isFile && entries[e2].name.indexOf(base) === 0) {
                        found = entries[e2];
                        break;
                    }
                }
                if (!found) await sleep(50);
            }
            if (found) {
                ctx.variant = variants[v];
            } else {
                log.push((variants[v].ext ? "name.png" : "name") + (variants[v].sep ? "+sep" : "") + " returned " + ok + " but no file appeared");
            }
        }
        if (!found) {
            throw new Error("exportSequenceFrame produced no file [" + log.join(" | ") + "] (temp folder: " + ctx.dir + ")");
        }
        var buf = await found.read({ format: ctx.storage.formats.binary });
        await maybe(function () { return found.delete(); });
        var bytes = new Uint8Array(buf);
        var img = decodePng(bytes);
        img.bytes = bytes;
        return img;
    }

    /* ---------- tracker orchestration ---------- */

    var MAX_TRACK_FRAMES = 900;

    function readNum(id, dflt) {
        var el = $(id);
        var n = el ? parseFloat(el.value) : NaN;
        return isFinite(n) ? n : dflt;
    }

    async function prepareTrack(ppro) {
        var host = await getSelectedClip(ppro);
        var seq = host.sequence;
        var frame = await getFrameSize(seq);
        var tpf = await getTicksPerFrame(seq);
        var st = await maybe(function () { return host.clip.getStartTime(); });
        if (st == null) throw new Error("cannot read the selected clip's start time on the timeline");
        var clipStart = Math.round(ticksOf(st));
        var clipDur = Math.round(ticksOf(await host.clip.getDuration()));
        var endT = clipStart + clipDur;
        var startT = clipStart;
        if (isChecked("trk-playhead", false)) {
            var pp = await maybe(function () { return seq.getPlayerPosition(); });
            var pt = pp == null ? NaN : Math.round(ticksOf(pp));
            if (!(pt >= clipStart && pt < endT)) throw new Error("the playhead is not inside the selected clip");
            startT = pt;
        }
        var ww = Math.max(160, Math.min(640, Math.round(readNum("trk-work", 480))));
        var hh = Math.max(90, Math.round(((ww * frame.h) / frame.w) / 2) * 2);
        var ctx = await makeExportCtx(ppro, seq, ww, hh);
        return { host: host, seq: seq, frame: frame, tpf: tpf, clipStart: clipStart, endT: endT, startT: startT, ctx: ctx };
    }

    async function runPixelTracker(ppro) {
        var prep = await prepareTrack(ppro);
        var frame = prep.frame;
        var total = Math.floor((prep.endT - prep.startT) / prep.tpf);
        if (total < 2) throw new Error("less than 2 frames between the start point and the end of the clip");
        var stride = Math.max(1, Math.ceil(total / MAX_TRACK_FRAMES));

        setResult("Exporting first frame…", "muted");
        var f0 = await grabFrame(prep.ctx, prep.startT);
        var sx = frame.w / f0.w;
        var sy = frame.h / f0.h;
        var region = {
            cx: (readNum("trk-x", 50) / 100) * f0.w,
            cy: (readNum("trk-y", 50) / 100) * f0.h,
            size: (readNum("trk-size", 25) / 100) * f0.h,
        };
        var tracker = createTracker(f0, region);
        var R = Math.max(6, Math.round((readNum("trk-search", 8) / 100) * f0.w));

        function sampleOf(res, t) {
            return {
                ticks: t - prep.startT,
                seq: t,
                x: res.cx * sx,
                y: res.cy * sy,
                scale: res.s * 100,
                rotation: (res.th * 180) / Math.PI,
            };
        }

        var samples = [sampleOf({ cx: region.cx, cy: region.cy, s: 1, th: 0 }, prep.startT)];
        var note = "";
        var began = Date.now();
        var count = Math.floor(total / stride);
        for (var i = 1; i <= count; i++) {
            if (state.stopTrack) {
                note = " · stopped by you";
                break;
            }
            var t = prep.startT + i * stride * prep.tpf;
            if (t > prep.endT) break;
            var fr = await grabFrame(prep.ctx, t);
            var res = tracker.step(fr, R);
            if (!res.ok && res.lost >= 8) {
                note = " · object lost at " + ((t - prep.startT) / TICKS).toFixed(2) + "s — stopped";
                break;
            }
            samples.push(sampleOf(res, t));
            if (i % 3 === 0 || i === count) {
                var perSec = i / Math.max(0.001, (Date.now() - began) / 1000);
                setResult("Tracking " + i + "/" + count + " (" + perSec.toFixed(1) + " fps) · " + res.used + " patches locked" + (res.ok ? "" : " · LOST"), "muted");
            }
            await yieldTick();
        }
        if (samples.length < 2) throw new Error("tracking produced fewer than 2 samples" + note);
        return {
            samples: samples,
            detail: "Pixel tracker · " + samples.length + " frames" + (stride > 1 ? " (every " + stride + ")" : "") + note,
            unit: "px",
            size: null,
        };
    }

    async function previewFrame(ppro) {
        var prep = await prepareTrack(ppro);
        var fr = await grabFrame(prep.ctx, prep.startT);
        if (trkUI.img) {
            trkUI.img.src = "data:image/png;base64," + toBase64(fr.bytes);
            trkUI.dims = { w: fr.w, h: fr.h };
            updateOverlay();
        }
        setResult("Preview frame " + fr.w + "×" + fr.h + " loaded — click the image to place the box centre.", "ok");
    }

    /* ---------- tracker panel (built at runtime) ---------- */

    var trkUI = { img: null, overlay: null, dims: null };

    function mk(tag, props, style) {
        var e = document.createElement(tag);
        var k;
        if (props) {
            for (k in props) {
                try {
                    if (k === "type") e.setAttribute("type", props[k]);
                    else e[k] = props[k];
                } catch (x) {}
            }
        }
        if (style) {
            for (k in style) {
                try { e.style[k] = style[k]; } catch (y) {}
            }
        }
        return e;
    }

    function updateOverlay() {
        if (!trkUI.overlay) return;
        var d = trkUI.dims || { w: 16, h: 9 };
        var x = readNum("trk-x", 50);
        var y = readNum("trk-y", 50);
        var sizeH = readNum("trk-size", 25);
        var sizeW = (sizeH * d.h) / d.w;
        trkUI.overlay.style.left = x - sizeW / 2 + "%";
        trkUI.overlay.style.top = y - sizeH / 2 + "%";
        trkUI.overlay.style.width = sizeW + "%";
        trkUI.overlay.style.height = sizeH + "%";
    }

    function buildTrackerUI() {
        var anchor = $("load-status") || $("result");
        var parent = anchor && anchor.parentNode ? anchor.parentNode : document.body;
        var box = mk("div", { id: "trk-box" }, { margin: "8px 0", padding: "6px", border: "1px solid #666" });
        box.appendChild(mk("div", { textContent: "Pixel tracker — select the SOURCE clip (hide text layers above it), place the box, press Track." }, { fontSize: "11px", marginBottom: "4px" }));

        var row = mk("div", null, { display: "flex", flexWrap: "wrap", alignItems: "center", marginBottom: "4px" });
        [["X %", "trk-x", "50"], ["Y %", "trk-y", "50"], ["Size %", "trk-size", "25"], ["Search %", "trk-search", "8"]].forEach(function (f) {
            row.appendChild(mk("span", { textContent: f[0] }, { fontSize: "11px", margin: "0 3px 0 6px" }));
            var inp = mk("input", { id: f[1], value: f[2] }, { width: "42px" });
            inp.addEventListener("input", updateOverlay);
            row.appendChild(inp);
        });
        box.appendChild(row);

        var row2 = mk("div", null, { display: "flex", flexWrap: "wrap", alignItems: "center", marginBottom: "4px" });
        var cb = mk("input", { id: "trk-playhead", type: "checkbox" });
        row2.appendChild(cb);
        row2.appendChild(mk("span", { textContent: "start at playhead" }, { fontSize: "11px", margin: "0 8px 0 3px" }));
        var bPrev = mk("button", { id: "btn-preview", className: "btn", textContent: "Preview frame" }, { marginRight: "4px" });
        var bTrack = mk("button", { id: "btn-track", className: "btn", textContent: "Track object" }, { marginRight: "4px" });
        var bStop = mk("button", { id: "btn-stop", className: "btn", textContent: "Stop" });
        row2.appendChild(bPrev);
        row2.appendChild(bTrack);
        row2.appendChild(bStop);
        box.appendChild(row2);

        var wrap = mk("div", null, { position: "relative", width: "100%" });
        trkUI.img = mk("img", null, { width: "100%" });
        trkUI.overlay = mk("div", null, { position: "absolute", border: "2px solid #ff3b30", left: "40%", top: "40%", width: "20%", height: "20%" });
        wrap.appendChild(trkUI.img);
        wrap.appendChild(trkUI.overlay);
        box.appendChild(wrap);

        trkUI.img.addEventListener("click", function (e) {
            try {
                var r = trkUI.img.getBoundingClientRect();
                var px = ((e.clientX - r.left) / r.width) * 100;
                var py = ((e.clientY - r.top) / r.height) * 100;
                $("trk-x").value = px.toFixed(1);
                $("trk-y").value = py.toFixed(1);
                updateOverlay();
            } catch (err) {}
        });

        bPrev.addEventListener("click", function () {
            if (state.busy) return;
            var ppro = tryPpro();
            if (!ppro) return setResult("Not inside Premiere.", "bad");
            setBusy(true);
            setResult("Exporting preview frame…", "muted");
            previewFrame(ppro)
                .catch(function (err) { setResult(err && err.message ? err.message : String(err), "bad"); })
                .then(function () { setBusy(false); });
        });
        bTrack.addEventListener("click", function () {
            if (state.busy) return;
            var ppro = tryPpro();
            if (!ppro) return setResult("Not inside Premiere.", "bad");
            state.stopTrack = false;
            setBusy(true);
            setResult("Preparing tracker…", "muted");
            runPixelTracker(ppro)
                .then(function (got) { loadSamples(got.samples, got.detail, got.unit, got.size); })
                .catch(function (err) {
                    console.error("KEYPATH tracker failed", err);
                    setResult(err && err.message ? err.message : String(err), "bad");
                })
                .then(function () { setBusy(false); });
        });
        bStop.addEventListener("click", function () {
            state.stopTrack = true;
        });

        try {
            parent.insertBefore(box, anchor);
        } catch (e) {
            document.body.appendChild(box);
        }
        updateOverlay();
    }

    /* ------------------------------------------------------------------ */
    /* Writing keyframes                                                   */
    /* Premiere invalidates script objects (params, actions, keyframes)    */
    /* after any transaction, so everything is re-fetched fresh and the    */
    /* keyframes/actions are created INSIDE the transaction that uses them. */
    /* ------------------------------------------------------------------ */

    // Runs one transaction. build(ca) executes inside it. ok is false only if Premiere reports failure.
    function runTx(project, label, build) {
        var okFlag = null;
        project.lockedAccess(function () {
            okFlag = project.executeTransaction(function (ca) {
                build(ca);
            }, label);
        });
        return { ok: okFlag !== false };
    }

    async function findComp(clip, want, wantName) {
        var chain = await clip.getComponentChain();
        var count = await chain.getComponentCount();
        for (var i = 0; i < count; i++) {
            var comp = await chain.getComponentAtIndex(i);
            var match = await comp.getMatchName();
            var name = ((await comp.getDisplayName()) || "").toLowerCase();
            if (match === want || name === wantName) return comp;
        }
        return null;
    }

    async function findOrAddTransform(ppro, project, clip, wantTransform) {
        var want = wantTransform ? MATCH_TRANSFORM : MATCH_MOTION;
        var wantName = wantTransform ? "transform" : "motion";

        var found = await findComp(clip, want, wantName);
        if (found) return found;
        // Motion requested but missing — reuse an existing Transform before adding a new one
        found = await findComp(clip, MATCH_TRANSFORM, "transform");
        if (found) return found;

        var chain = await clip.getComponentChain();
        var count = await chain.getComponentCount();
        var created = await ppro.VideoFilterFactory.createComponent(MATCH_TRANSFORM);
        var err = null;
        var res = runTx(project, "KEYPATH add Transform", function (ca) {
            try {
                var action =
                    typeof chain.createAppendComponentAction === "function"
                        ? chain.createAppendComponentAction(created)
                        : chain.createInsertComponentAction(created, Math.min(count, 2));
                ca.addAction(action);
            } catch (e) {
                err = e;
            }
        });
        if (err) throw new Error("Adding Transform failed: " + (err.message || err));
        if (!res.ok) throw new Error("Premiere refused to add a Transform effect to this clip.");

        // The component chain updates asynchronously — poll for the new effect
        for (var attempt = 0; attempt < 10; attempt++) {
            await yieldTick();
            found = await findComp(clip, MATCH_TRANSFORM, "transform");
            if (found) return found;
        }
        throw new Error("Transform effect was added but could not be found on the clip.");
    }

    // Always returns a FRESH parameter object: key is "pos" | "sc" | "rot"
    async function resolveParam(clip, cref, key) {
        var comp = await findComp(clip, cref.match, cref.name);
        if (!comp) throw new Error("Effect '" + cref.name + "' not found on the clip anymore.");
        var psr = await findPsr(comp);
        return psr[key];
    }

    async function enableStopwatch(host, cref, keys) {
        var params = {};
        for (var i = 0; i < keys.length; i++) {
            params[keys[i]] = await resolveParam(host.clip, cref, keys[i]);
        }
        var err = null;
        var res = runTx(host.project, "KEYPATH enable stopwatch", function (ca) {
            for (var j = 0; j < keys.length; j++) {
                try {
                    ca.addAction(params[keys[j]].createSetTimeVaryingAction(true));
                } catch (e) {
                    if (!err) err = e;
                }
            }
        });
        return { ok: res.ok, error: err };
    }

    // Writes one property in small batches; each batch re-resolves the parameter first.
    async function writeKeys(ppro, host, cref, key, samples, inPointTicks, valueOf, label) {
        var added = 0;
        var failed = false;
        var firstError = null;
        for (var i = 0; i < samples.length; i += BATCH_SIZE) {
            var chunk = samples.slice(i, i + BATCH_SIZE);
            var param = await resolveParam(host.clip, cref, key);
            if (!param) throw new Error("Parameter not found for " + label + ".");
            var res = runTx(host.project, "KEYPATH " + label + " keys", function (ca) {
                for (var j = 0; j < chunk.length; j++) {
                    try {
                        var keyTicks = Math.round(inPointTicks + chunk[j].ticks);
                        if (!isFinite(keyTicks)) continue;
                        var kf = param.createKeyframe(valueOf(chunk[j]));
                        kf.position = ppro.TickTime.createWithTicks(String(keyTicks));
                        if (ca.addAction(param.createAddKeyframeAction(kf)) !== false) added += 1;
                    } catch (e) {
                        if (!firstError) firstError = e;
                    }
                }
            });
            if (!res.ok) failed = true;
            await yieldTick();
        }
        return { added: added, failed: failed, error: firstError };
    }

    // Convert a delta measured in the source's units into the target Position's units.
    function convertDelta(dx, dy, tgtNorm, frame) {
        var nx;
        var ny;
        if (state.srcUnit === "norm") {
            nx = dx;
            ny = dy;
        } else {
            var sw = state.srcSize ? state.srcSize.w : frame.w;
            var sh = state.srcSize ? state.srcSize.h : frame.h;
            nx = dx / sw;
            ny = dy / sh;
        }
        return tgtNorm ? { x: nx, y: ny } : { x: nx * frame.w, y: ny * frame.h };
    }

    async function applyKeys() {
        var ctx = { stage: "" };
        try {
            return await applyKeysInner(ctx);
        } catch (e) {
            var msg = e && e.message ? e.message : String(e);
            throw new Error(ctx.stage ? "[" + ctx.stage + "] " + msg : msg);
        }
    }

    async function applyKeysInner(ctx) {
        var samples = planned();
        if (samples.length > MAX_SAMPLES) samples = thinList(samples, MAX_SAMPLES);
        if (!samples.length) throw new Error("Load tracking first (Read selected clip).");
        var ppro = tryPpro();
        if (!ppro) throw new Error("Premiere host not found.");

        var props = {
            position: isChecked("prop-position", true),
            scale: isChecked("prop-scale", false),
            rotation: isChecked("prop-rotation", false),
        };
        if (!props.position && !props.scale && !props.rotation) throw new Error("Select a property.");

        ctx.stage = "select clip";
        var host = await getSelectedClip(ppro);
        var inPointTicks = Math.round(ticksOf(await host.clip.getInPoint()));
        var name = (await host.clip.getName()) || "clip";
        var frame = await getFrameSize(host.sequence);

        // Samples with absolute sequence time (pixel tracker): line them up with the TARGET clip's own timeline position
        if (samples[0] && samples[0].seq != null) {
            var stT = await maybe(function () { return host.clip.getStartTime(); });
            if (stT != null) {
                var tStart = Math.round(ticksOf(stT));
                var tDur = Math.round(ticksOf(await host.clip.getDuration()));
                var win = [];
                for (var wi = 0; wi < samples.length; wi++) {
                    var ws = samples[wi];
                    if (ws.seq >= tStart && ws.seq <= tStart + tDur) {
                        win.push({ ticks: ws.seq - tStart, seq: ws.seq, x: ws.x, y: ws.y, scale: ws.scale, rotation: ws.rotation });
                    }
                }
                if (win.length < 2) {
                    throw new Error("the target clip (" + name + ") does not overlap the tracked frames — move it over the tracked range");
                }
                samples = win;
            }
        }

        ctx.stage = "find Transform";
        var comp = await findOrAddTransform(ppro, host.project, host.clip, isChecked("use-transform", true));
        var cref = {
            match: await comp.getMatchName(),
            name: ((await comp.getDisplayName()) || "").toLowerCase(),
        };
        var compName = (await comp.getDisplayName()) || "Transform";
        await yieldTick();

        ctx.stage = "read parameters";
        var pos = await resolveParam(host.clip, cref, "pos");
        var sc = await resolveParam(host.clip, cref, "sc");
        var rot = await resolveParam(host.clip, cref, "rot");
        if (props.position && !pos) throw new Error("No Position parameter found on " + compName + ".");

        var tIn = ppro.TickTime.createWithTicks(String(inPointTicks));
        var currentPos = null;
        if (pos) {
            currentPos = unpackPoint(await maybe(function () { return pos.getValueAtTime(tIn); }));
        }
        var baseScale = sc ? await numAt(sc, tIn, 100) : 100;
        var baseRot = rot ? await numAt(rot, tIn, 0) : 0;
        var s0 = samples[0].scale || 100;
        var r0 = samples[0].rotation || 0;
        var tgtNorm = currentPos ? (Math.abs(currentPos.x) <= 4 && Math.abs(currentPos.y) <= 4) : true;
        var targetBaseX = currentPos ? currentPos.x : (tgtNorm ? 0.5 : frame.w / 2);
        var targetBaseY = currentPos ? currentPos.y : (tgtNorm ? 0.5 : frame.h / 2);
        var sourceBaseX = samples[0].x;
        var sourceBaseY = samples[0].y;

        console.log("KEYPATH apply", {
            comp: compName,
            srcUnit: state.srcUnit,
            tgtNormalized: tgtNorm,
            frame: frame,
            inPointTicks: inPointTicks,
            samples: samples.length,
        });

        var jobs = [];
        if (props.position && pos) {
            jobs.push({
                key: "pos",
                label: "position",
                valueOf: function (s) {
                    var d = convertDelta(s.x - sourceBaseX, s.y - sourceBaseY, tgtNorm, frame);
                    var x = state.channel === "y" ? targetBaseX : targetBaseX + d.x;
                    var y = state.channel === "x" ? targetBaseY : targetBaseY + d.y;
                    return new ppro.PointF(x, y);
                },
            });
        }
        if (props.scale && sc) {
            jobs.push({ key: "sc", label: "scale", valueOf: function (s) { return baseScale * (s.scale / s0); } });
        }
        if (props.rotation && rot) {
            jobs.push({ key: "rot", label: "rotation", valueOf: function (s) { return baseRot + (s.rotation - r0); } });
        }
        if (!jobs.length) throw new Error("None of the selected properties exist on " + compName + ".");

        var mo = motionSummary(samples, state.srcUnit);
        var moves = false;
        for (var m = 0; m < jobs.length; m++) {
            if (jobs[m].key === "pos" && ((mo.moveX && state.channel !== "y") || (mo.moveY && state.channel !== "x"))) moves = true;
            if (jobs[m].key === "sc" && mo.moveScale) moves = true;
            if (jobs[m].key === "rot" && mo.moveRot) moves = true;
        }
        if (!moves) {
            throw new Error(
                "The loaded tracking has no motion for the selected properties/channel, so every key would be identical. " +
                "Reload the tracking (for mask tracking: copy the Mask Path keyframes and use Read clipboard)."
            );
        }

        // STEP 1: enable stopwatch (own transaction, fresh params)
        ctx.stage = "enable stopwatch";
        var keyList = jobs.map(function (j) { return j.key; });
        var tv = await enableStopwatch(host, cref, keyList);
        if (tv.error) throw new Error(tv.error.message || String(tv.error));
        if (!tv.ok) console.warn("KEYPATH: stopwatch transaction reported failure");
        await yieldTick();

        // STEP 2: write keys, one property at a time, in small batches
        var anyFailed = false;
        var firstError = null;
        for (var j = 0; j < jobs.length; j++) {
            ctx.stage = "write " + jobs[j].label;
            var r = await writeKeys(ppro, host, cref, jobs[j].key, samples, inPointTicks, jobs[j].valueOf, jobs[j].label);
            if (r.failed) anyFailed = true;
            if (r.error && !firstError) firstError = r.error;
        }

        // STEP 3: read back what Premiere actually stored
        ctx.stage = "verify";
        await yieldTick();
        var report = [];
        var total = 0;
        for (var v = 0; v < jobs.length; v++) {
            var vp = await resolveParam(host.clip, cref, jobs[v].key);
            var tl = vp ? await keyTimes(vp) : [];
            var n = tl.length;
            total += n;
            var extra = "";
            if (n >= 2) {
                var first = await maybe(function () { return vp.getValueAtTime(tl[0]); });
                var last = await maybe(function () { return vp.getValueAtTime(tl[n - 1]); });
                if (jobs[v].key === "pos") {
                    var a = unpackPoint(first);
                    var b = unpackPoint(last);
                    var dg = tgtNorm ? 3 : 1;
                    if (a && b) {
                        extra = " (" + a.x.toFixed(dg) + "," + a.y.toFixed(dg) + " → " + b.x.toFixed(dg) + "," + b.y.toFixed(dg) + ")";
                    }
                } else {
                    extra = " (" + unpackNum(first).toFixed(1) + " → " + unpackNum(last).toFixed(1) + ")";
                }
            }
            report.push(jobs[v].label + " " + n + extra);
        }

        if (!total) {
            var why = firstError ? firstError.message || String(firstError) : anyFailed ? "a transaction reported failure" : "no error reported";
            throw new Error("No keyframes were stored on " + compName + " (" + why + ").");
        }

        var note = "";
        if (props.scale && !sc) note += " · no Scale param";
        if (props.rotation && !rot) note += " · no Rotation param";
        if (anyFailed) note += " · some batches reported failure";
        if (firstError) note += " · first error: " + (firstError.message || String(firstError));

        ctx.stage = "";
        return "Wrote keys on “" + name + "” → " + compName + ": " + report.join(", ") + note;
    }

    function setBusy(on) {
        state.busy = on;
        var buttons = ["btn-clip", "btn-clipboard", "btn-apply", "btn-preview", "btn-track", "mode-follow", "mode-stabilize", "ch-xy", "ch-x", "ch-y"];
        for (var i = 0; i < buttons.length; i++) {
            var el = $(buttons[i]);
            if (!el) continue;
            if (on) {
                el.setAttribute("disabled", "true");
            } else {
                el.removeAttribute("disabled");
            }
        }
    }

    function describeClipboard(data) {
        if (data == null) return "nothing";
        if (typeof data === "string") return "text(" + data.length + ")";
        if (typeof data !== "object") return typeof data;
        var parts = [];
        for (var k in data) {
            if (Object.prototype.hasOwnProperty.call(data, k)) parts.push(k + ": " + describeValue(data[k]));
        }
        return parts.length ? parts.join(", ") : "empty object";
    }

    async function readClipboardText() {
        var cb = navigator.clipboard;
        if (!cb) throw new Error("Clipboard API not available.");
        var attempts = [];
        if (typeof cb.getContent === "function") attempts.push({ name: "getContent", fn: function () { return cb.getContent(); } });
        if (typeof cb.readText === "function") attempts.push({ name: "readText", fn: function () { return cb.readText(); } });
        var notes = [];
        for (var i = 0; i < attempts.length; i++) {
            try {
                var data = await attempts[i].fn();
                var text = clipboardText(data);
                if (text && text.trim() && text !== "{}" && text !== "null") return text;
                notes.push(attempts[i].name + " → " + describeClipboard(data));
            } catch (e) {
                notes.push(attempts[i].name + " failed: " + (e && e.message ? e.message : e));
            }
        }
        console.log("KEYPATH clipboard", notes);
        throw new Error(
            "Clipboard gave no readable text (" + (notes.join(" | ") || "no clipboard API") + "). " +
            "Click the paste box and press Ctrl/Cmd+V instead."
        );
    }

    $("btn-clipboard").addEventListener("click", function () {
        setResult("Reading clipboard…", "muted");
        readClipboardText()
            .then(function (text) {
                try {
                    $("paste").value = text.slice(0, 4000);
                } catch (e) {}
                var got;
                try {
                    got = ingest(text);
                } catch (e) {
                    throw new Error(
                        (e && e.message ? e.message : String(e)) +
                        " [clipboard " + text.length + " chars, starts: \"" + text.slice(0, 70).replace(/\s+/g, " ") + "\"]"
                    );
                }
                loadSamples(got.samples, got.detail, got.unit, got.size);
            })
            .catch(function (err) {
                setResult(err && err.message ? err.message : String(err), "bad");
            });
    });

    $("btn-clip").addEventListener("click", function () {
        if (state.busy) return;
        var ppro = tryPpro();
        if (!ppro) {
            setResult("Not inside Premiere.", "bad");
            return;
        }
        setBusy(true);
        setResult("Reading clip (max 80 keys)…", "muted");
        readClipTracking(ppro)
            .then(function (got) {
                loadSamples(got.samples, got.detail, got.unit, got.size);
            })
            .catch(function (err) {
                setResult(err && err.message ? err.message : String(err), "bad");
            })
            .then(function () {
                setBusy(false);
            });
    });

    var pasteTimer = null;
    function ingestPasteBox() {
        try {
            var v = asText($("paste").value).trim();
            if (v.length < 30) return;
            var got = ingest(v);
            loadSamples(got.samples, got.detail, got.unit, got.size);
        } catch (err) {
            setResult(err.message || String(err), "bad");
        }
    }
    ["paste", "input", "change"].forEach(function (evt) {
        $("paste").addEventListener(evt, function () {
            clearTimeout(pasteTimer);
            pasteTimer = setTimeout(ingestPasteBox, 200);
        });
    });

    function setMode(mode) {
        state.mode = mode;
        $("mode-follow").className = mode === "follow" ? "btn on" : "btn";
        $("mode-stabilize").className = mode === "stabilize" ? "btn on" : "btn";
        refreshPlan();
    }
    $("mode-follow").addEventListener("click", function () { setMode("follow"); });
    $("mode-stabilize").addEventListener("click", function () { setMode("stabilize"); });

    function setChannel(ch) {
        state.channel = ch;
        $("ch-xy").className = ch === "xy" ? "btn on" : "btn";
        $("ch-x").className = ch === "x" ? "btn on" : "btn";
        $("ch-y").className = ch === "y" ? "btn on" : "btn";
    }
    $("ch-xy").addEventListener("click", function () { setChannel("xy"); });
    $("ch-x").addEventListener("click", function () { setChannel("x"); });
    $("ch-y").addEventListener("click", function () { setChannel("y"); });

    $("nth").addEventListener("input", function () {
        state.everyNth = Number($("nth").value);
        refreshPlan();
    });

    $("btn-apply").addEventListener("click", function () {
        if (state.busy) return;
        setBusy(true);
        setResult("Applying keys…", "muted");
        applyKeys()
            .then(function (msg) { setResult(msg, "ok"); })
            .catch(function (err) {
                console.error("KEYPATH apply failed", err);
                setResult(err && err.message ? err.message : String(err), "bad");
            })
            .then(function () { setBusy(false); });
    });

    try {
        buildTrackerUI();
    } catch (e) {
        console.error("KEYPATH tracker panel could not be built", e);
    }
    if (typeof globalThis !== "undefined" && globalThis.__KEYPATH_TEST__ === true) {
        globalThis.__KEYPATH_API__ = { decodePng: decodePng, inflate: inflate, createTracker: createTracker };
    }
    restoreCache();
    refreshPlan();
})();
