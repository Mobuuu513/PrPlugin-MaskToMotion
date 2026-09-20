/* KEYPATH 1.0.15 — Mask scan matches 'Path' as well as 'Mask …', lists every parameter it saw, clearer Unassigned-Mask guidance */
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

    function loadSamples(samples, detail, unit, size) {
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

    // Reads mask-path keyframes directly from the selected clip's effects (no clipboard).
    async function readMaskFromClip(host, diag) {
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
                if (seenNames.length < 14) seenNames.push(pname || "(unnamed)");
                // New mask UI labels the property just "Path"; older builds use "Mask Path"
                if (!/mask|path/i.test(pname)) continue;
                var tl = await keyTimes(prm);
                diag.lines.push(dname + " › " + pname + ": " + tl.length + " keys");
                if (tl.length >= 2) cands.push({ dname: dname, pname: pname, prm: prm, times: tl });
            }
            diag.names.push(dname + " [" + seenNames.join(", ") + (n > seenNames.length ? ", …" : "") + "]");
            if (ci % 3 === 2) await yieldTick();
        }

        if (!cands.length) {
            diag.note = "no keyframed Mask Path parameter is exposed on this clip";
            return null;
        }
        cands.sort(function (a, b) { return b.times.length - a.times.length; });

        for (var c = 0; c < cands.length; c++) {
            var cand = cands[c];
            var times = thinList(cand.times, MAX_SAMPLES);
            var keys = [];
            var seen = "";
            for (var k = 0; k < times.length; k++) {
                if (k && k % 8 === 0) {
                    setResult("Reading mask " + k + "/" + times.length + "…", "muted");
                    await yieldTick();
                }
                var tt = times[k];
                var kf = await maybe(function () { return cand.prm.getKeyframePtr(tt); });
                var raw = kf ? (kf.value != null ? kf.value : kf) : null;
                var shape = valueToShape(raw);
                if (!shape) {
                    var gv = await maybe(function () { return cand.prm.getValueAtTime(tt); });
                    if (!seen) seen = describeValue(raw) + " / " + describeValue(gv);
                    shape = valueToShape(gv);
                }
                if (shape && shape.vertices && shape.vertices.length) {
                    keys.push({ ticks: ticksOf(tt), shape: shape });
                }
            }
            if (keys.length >= 2) {
                return samplesFromShapes(keys, cand.dname + " › " + cand.pname);
            }
            diag.note = cand.pname + " has " + cand.times.length + " keys but its values are not readable by the API (" + (seen || "empty") + ")";
        }
        return null;
    }

    async function readClipTracking(ppro) {
        var host = await getSelectedClip(ppro);
        var chain = await host.clip.getComponentChain();
        var count = await chain.getComponentCount();
        var names = [];
        var best = null;
        var i;

        for (i = 0; i < count; i++) {
            var comp = await chain.getComponentAtIndex(i);
            var dname = await comp.getDisplayName();
            var match = await comp.getMatchName();
            if (skipComp(dname, match)) continue;
            names.push(dname);
            if (!likelyTrack(dname, match) && count > 3) continue;

            var psr = await findPsr(comp);
            if (!psr.pos) continue;
            var times = await keyTimes(psr.pos);
            var score = (times.length || 1) + (psr.sc ? 2 : 0) + (psr.rot ? 2 : 0);
            if (match === MATCH_MOTION) score -= 3;
            if (!best || score > best.score) {
                best = {
                    dname: dname,
                    match: match,
                    pos: psr.pos,
                    sc: psr.sc,
                    rot: psr.rot,
                    times: times,
                    score: score,
                };
            }
        }

        var posKeys = best && best.pos ? best.times.length : 0;
        if (posKeys < 2) {
            // No animated Position: mask tracking lives in the mask path — read it directly from the clip
            var diag = { lines: [], names: [], note: "" };
            var masked = await readMaskFromClip(host, diag);
            if (masked) return masked;
            console.log("KEYPATH mask scan", diag);
            throw new Error(
                (best && best.pos
                    ? "Position on " + best.dname + " has no keyframes, so there is no motion to read. "
                    : "No animated Position on this clip. ") +
                "Premiere only exposes masks that are assigned to an effect (e.g. draw the mask under Opacity, then track it). " +
                "Masks under “Unassigned Masks” can only come through the clipboard: click the “Path” name in Effect Controls, press Ctrl/Cmd+C, then use Read clipboard." +
                " [scan: " + (diag.note || "no keyframed mask parameter") + " | " + diag.names.join(" | ").slice(0, 420) + "]"
            );
        }

        var times = thinList(best.times, MAX_SAMPLES);

        setResult("Reading " + times.length + " keys from " + best.dname + "…", "muted");
        var samples = [];
        var firstTicks = -1;

        for (i = 0; i < times.length; i++) {
            if (i && i % 8 === 0) {
                setResult("Reading " + i + "/" + times.length + "…", "muted");
                await yieldTick();
            }
            var tt = times[i];
            var ticksVal = ticksOf(tt);
            if (firstTicks < 0) firstTicks = ticksVal;

            // Normalize to relative ticks starting from 0
            var relTicks = ticksVal - firstTicks;

            var pv = await readPoint(best.pos, tt);
            if (!pv) continue;
            var scale = 100;
            var rotation = 0;
            if (best.sc) {
                try { scale = unpackNum(await best.sc.getValueAtTime(tt)); } catch (e1) {}
            }
            if (best.rot) {
                try { rotation = unpackNum(await best.rot.getValueAtTime(tt)); } catch (e2) {}
            }
            samples.push({
                ticks: relTicks,
                x: pv.x,
                y: pv.y,
                scale: scale,
                rotation: rotation,
            });
        }

        if (!samples.length) {
            throw new Error("Found " + best.dname + " Position but values were empty.");
        }

        var dropped = best.times.length > samples.length ? " (thinned from " + best.times.length + ")" : "";
        return {
            samples: samples,
            detail: best.dname + " · " + samples.length + " keys" + dropped,
        };
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

        var currentPos = null;
        if (pos) {
            var tIn = ppro.TickTime.createWithTicks(String(inPointTicks));
            currentPos = unpackPoint(await maybe(function () { return pos.getValueAtTime(tIn); }));
        }
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
            jobs.push({ key: "sc", label: "scale", valueOf: function (s) { return s.scale; } });
        }
        if (props.rotation && rot) {
            jobs.push({ key: "rot", label: "rotation", valueOf: function (s) { return s.rotation; } });
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
        var buttons = ["btn-clip", "btn-clipboard", "btn-apply", "mode-follow", "mode-stabilize", "ch-xy", "ch-x", "ch-y"];
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

    refreshPlan();
})();
