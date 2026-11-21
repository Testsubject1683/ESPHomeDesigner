import { getForecastPlan, getWidgetDataSource, globalIdForSensor } from './slot_plan.js';

/**
 * @typedef {import('./slot_plan.js').WeatherForecastWidget} WeatherForecastWidget
 * @typedef {import('./slot_plan.js').ForecastPlan} ForecastPlan
 * @typedef {import('./slot_plan.js').ForecastSlot} ForecastSlot
 */

function insertTopLevelSectionEntries(lines, sectionName, entryLines, commentLine = '') {
    if (!Array.isArray(lines) || entryLines.length === 0) return;

    const sectionHeader = `${sectionName}:`;
    const sectionIndex = lines.findIndex((line) => line.trim() === sectionHeader);
    const linesToInsert = commentLine ? [commentLine, ...entryLines] : entryLines;

    if (sectionIndex === -1) {
        if (lines.length > 0 && lines[lines.length - 1].trim() !== '') {
            lines.push('');
        }
        if (commentLine) lines.push(commentLine);
        lines.push(sectionHeader, ...entryLines);
        return;
    }

    let insertIndex = sectionIndex + 1;
    while (insertIndex < lines.length) {
        const line = lines[insertIndex];
        if (/^[a-z0-9_]+:(\s*#.*)?$/i.test(line)) {
            break;
        }
        insertIndex++;
    }

    lines.splice(insertIndex, 0, ...linesToInsert);
}

/**
 * @param {WeatherForecastWidget[]} widgets
 * @returns {WeatherForecastWidget[]}
 */
const actionSourceWidgets = (widgets) =>
    (widgets || []).filter(w => w && w.type === "weather_forecast" && getWidgetDataSource(w) === "esphome_action");

/**
 * Emits one global per forecast slot value. Numeric slots are floats,
 * condition slots are std::string. Shared slots are deduplicated.
 *
 * @param {Record<string, any>} context
 */
export const onExportGlobals = (context) => {
    const { lines, widgets = [] } = context;
    const targets = actionSourceWidgets(widgets);
    if (targets.length === 0) return;

    /** @type {Set<string>} */
    const emitted = new Set();
    let headerAdded = false;

    targets.forEach(w => {
        const plan = getForecastPlan(w);
        plan.slots.forEach(slot => {
            /** @type {Array<{ sensorId: string, kind: 'num' | 'cond' }>} */
            const values = plan.mode === "hourly"
                ? [{ sensorId: slot.highId, kind: "num" }, { sensorId: slot.condId, kind: "cond" }]
                : [
                    { sensorId: slot.highId, kind: "num" },
                    { sensorId: slot.lowId, kind: "num" },
                    { sensorId: slot.condId, kind: "cond" }
                ];

            values.forEach(({ sensorId, kind }) => {
                const gid = globalIdForSensor(sensorId);
                if (emitted.has(gid)) return;
                emitted.add(gid);
                if (!headerAdded) {
                    lines.push("# Weather Forecast Action Globals (filled by periodic weather.get_forecasts calls)");
                    headerAdded = true;
                }
                if (kind === "cond") {
                    lines.push(`- id: ${gid}`, "  type: std::string", "  restore_value: false", "  initial_value: '\"\"'");
                } else {
                    lines.push(`- id: ${gid}`, "  type: float", "  restore_value: false", "  initial_value: 'NAN'");
                }
            });
        });
    });
};

/**
 * @param {string} entity
 * @param {ForecastSlot[]} slots
 * @param {string} type
 * @returns {string[]}
 */
const buildParseLambdaLines = (entity, slots, type) => {
    /** @type {string[]} */
    const body = [];
    // The action's response_template (rendered HA-side) delivers a compact JSON
    // array string: [[datetime, temperature, templow, condition], ...]. Keeping only
    // these fields keeps the response frame below ESP8266's 8 KiB API frame limit
    // (MAX_MESSAGE_SIZE); the raw forecast array can exceed it (BAD_DATA_PACKET).
    body.push(`JsonDocument doc;`);
    body.push(`if (deserializeJson(doc, response["response"].as<const char*>())) {`);
    body.push(`  ESP_LOGW("weather", "Bad forecast JSON for ${entity} (needs HA Core >= 2025.11, ESPHome >= 2025.10, capture_response + response_template)");`);
    body.push(`  return;`);
    body.push(`}`);
    body.push(`JsonArrayConst fc = doc.as<JsonArrayConst>();`);
    body.push(`if (fc.isNull()) {`);
    body.push(`  ESP_LOGW("weather", "No forecast array for ${entity}: response_empty=%d has_response_key=%d (action responses need HA Core >= 2025.11 and ESPHome >= 2025.10)", response.isNull() ? 1 : 0, response["response"].isNull() ? 0 : 1);`);
    body.push(`  return;`);
    body.push(`}`);
    body.push(`auto getf = [](JsonVariantConst v) -> float { return v.isNull() ? NAN : v.as<float>(); };`);

    if (type === "daily") {
        slots.forEach(slot => {
            if (slot.kind.type !== "daily") return;
            const d = slot.kind.dayIndex;
            body.push(`if (${d} < fc.size()) {`);
            body.push(`  JsonVariantConst e = fc[${d}];`);
            body.push(`  id(${globalIdForSensor(slot.highId)}) = getf(e[1]);`);
            body.push(`  id(${globalIdForSensor(slot.lowId)}) = getf(e[2]);`);
            body.push(`  id(${globalIdForSensor(slot.condId)}) = std::string(e[3] | "");`);
            body.push(`}`);
        });
        return body;
    }

    body.push(`auto t = id(ha_time).now();`);
    // HA passes forecast datetimes through unnormalized: the wall-clock part may
    // carry a non-UTC offset (e.g. ...T15:00:00+01:00). Parse that offset so the
    // result is a true UTC epoch regardless of the source timezone.
    body.push(`auto parse_ts = [](const std::string &dt) -> time_t {`);
    body.push(`  if (dt.size() < 19) return (time_t) -1;`);
    body.push(`  std::string norm = dt.substr(0, 19);`);
    body.push(`  norm[10] = ' ';`);
    body.push(`  ESPTime et{};`);
    body.push(`  if (!ESPTime::strptime(norm, et)) return (time_t) -1;`);
    body.push(`  et.recalc_timestamp_utc(false);`);
    body.push(`  time_t ts = et.timestamp;`);
    body.push(`  if (dt.size() > 19 && (dt[19] == '+' || dt[19] == '-')) {`);
    body.push(`    int sign = dt[19] == '-' ? -1 : 1;`);
    body.push(`    std::string off = dt.substr(20);`);
    body.push(`    int oh = 0, om = 0;`);
    body.push(`    if (off.size() >= 5 && off[2] == ':') { oh = atoi(off.substr(0, 2).c_str()); om = atoi(off.substr(3, 2).c_str()); }`);
    body.push(`    else if (off.size() >= 4) { oh = atoi(off.substr(0, 2).c_str()); om = atoi(off.substr(2, 2).c_str()); }`);
    body.push(`    else if (off.size() >= 2) { oh = atoi(off.substr(0, 2).c_str()); }`);
    body.push(`    ts -= (time_t) sign * (oh * 3600 + om * 60);`);
    body.push(`  }`);
    body.push(`  return ts;`);
    body.push(`};`);
    body.push(`time_t now_ts = t.is_valid() ? t.timestamp : (time_t) -1;`);
    body.push(`int lhour = t.hour, lmin = t.minute, lsec = t.second;`);
    body.push(`if (now_ts < 0 && fc.size() > 0) {`);
    body.push(`  now_ts = parse_ts(std::string(fc[0][0] | ""));`);
    body.push(`  if (now_ts >= 0) {`);
    body.push(`    ESPTime nt = ESPTime::from_epoch_utc(now_ts);`);
    body.push(`    lhour = nt.hour; lmin = nt.minute; lsec = nt.second;`);
    body.push(`    ESP_LOGW("weather", "hourly: ha_time not synced for ${entity}; anchoring to first forecast entry (ts=%d)", (int) now_ts);`);
    body.push(`  }`);
    body.push(`}`);
    body.push(`if (now_ts < 0) {`);
    body.push(`  ESP_LOGW("weather", "hourly: no valid time and no parsable forecast datetime for ${entity}; skipping parse");`);
    body.push(`  return;`);
    body.push(`}`);
    body.push(`time_t base_hour = (now_ts / 3600) * 3600;`);
    body.push(`time_t day_start = now_ts - ((time_t) lhour * 3600 + (time_t) lmin * 60 + lsec);`);
    body.push(`int matched = 0;`);

    slots.forEach(slot => {
        if (slot.kind.type !== "hourly") return;
        body.push(`{`);
        if (slot.kind.relative) {
            body.push(`  time_t target = base_hour + ${slot.kind.hoursAhead} * 3600;`);
        } else {
            body.push(`  time_t target = day_start + ${slot.kind.hour} * 3600;`);
            body.push(`  if (now_ts > target + 3600) target += 86400;`);
        }
        body.push(`  for (JsonVariantConst e : fc) {`);
        body.push(`    if (parse_ts(std::string(e[0] | "")) == target) {`);
        body.push(`      id(${globalIdForSensor(slot.highId)}) = getf(e[1]);`);
        body.push(`      id(${globalIdForSensor(slot.condId)}) = std::string(e[3] | "");`);
        body.push(`      matched++;`);
        body.push(`      break;`);
        body.push(`    }`);
        body.push(`  }`);
        body.push(`}`);
    });
    body.push(`if (matched == 0 && fc.size() > 0) {`);
    body.push(`  ESP_LOGW("weather", "hourly: no forecast entry matched for ${entity} (entries=%d first_datetime=%s)", (int) fc.size(), std::string(fc[0][0] | "").c_str());`);
    body.push(`}`);
    body.push(`ESP_LOGI("weather", "hourly parse ${entity}: entries=%d matched=%d have_time=%d", (int) fc.size(), matched, t.is_valid() ? 1 : 0);`);
    return body;
};

/**
 * Emits a periodic interval that calls weather.get_forecasts on-device via
 * homeassistant.action with capture_response, parses the forecast JSON in the
 * on_success lambda, stores it in the globals, and refreshes the local
 * template sensors plus the display widgets.
 *
 * @param {Record<string, any>} context
 */
export const onExportComponents = (context) => {
    const { lines, widgets = [], displayId, isLvgl } = context;
    const targets = actionSourceWidgets(widgets);
    if (targets.length === 0) return;

    /** @type {Map<string, { entity: string, type: string, interval: string, slots: ForecastSlot[], widgets: Array<{ id: string, plan: ForecastPlan }> }>} */
    const groups = new Map();

    targets.forEach(w => {
        const plan = getForecastPlan(w);
        const type = plan.mode === "hourly" ? "hourly" : "daily";
        const key = `${plan.weatherEntity}|${type}`;
        if (!groups.has(key)) {
            groups.set(key, { entity: plan.weatherEntity, type, interval: plan.refreshInterval, slots: [], widgets: [] });
        }
        const group = groups.get(key);
        if (!group) return;
        group.widgets.push({ id: w.id, plan });
        plan.slots.forEach(slot => {
            if (!group.slots.some(s => s.highId === slot.highId)) group.slots.push(slot);
        });
    });

    /** @type {string[]} */
    const entries = [];

    groups.forEach(group => {
        const lambdaBody = buildParseLambdaLines(group.entity, group.slots, group.type);

        /** @type {Set<string>} */
        const sensorIds = new Set();
        group.slots.forEach(slot => {
            sensorIds.add(slot.highId);
            if (group.type === "daily") sensorIds.add(slot.lowId);
            sensorIds.add(slot.condId);
        });

        entries.push(`  - interval: ${group.interval}`);
        entries.push(`    startup_delay: 20s`);
        entries.push(`    then:`);
        entries.push(`      - if:`);
        entries.push(`          condition:`);
        entries.push(`            wifi.connected:`);
        entries.push(`          then:`);
        entries.push(`            - homeassistant.action:`);
        entries.push(`                action: weather.get_forecasts`);
        entries.push(`                data:`);
        entries.push(`                  entity_id: ${group.entity}`);
        entries.push(`                  type: ${group.type}`);
        entries.push(`                capture_response: true`);
        // HA-side Jinja compaction: only [datetime, temperature, templow, condition] per
        // entry are sent back, keeping the frame under ESP8266's 8 KiB API limit.
        entries.push(`                response_template: >-`);
        // HA renders response_template in a sandboxed Jinja env: list.append is
        // blocked ("unsafe"), so build the JSON array with a plain list display in
        // a for loop instead.
        entries.push(`                  [{% for e in response['${group.entity}']['forecast'] %}{{ [e.get('datetime'), e.get('temperature'), e.get('templow'), e.get('condition')] | tojson }}{% if not loop.last %},{% endif %}{% endfor %}]`);
        entries.push(`                on_success:`);
        entries.push(`                  - lambda: |-`);
        lambdaBody.forEach(l => entries.push(`                      ${l}`));
        sensorIds.forEach(sid => entries.push(`                  - component.update: ${sid}`));
        if (isLvgl) {
            group.widgets.forEach(({ id, plan }) => {
                const safeWidgetId = id.replace(/-/g, "_");
                for (let i = 0; i < plan.count; i++) {
                    entries.push(`                  - lvgl.widget.refresh: ${safeWidgetId}_day${i}`);
                    entries.push(`                  - lvgl.widget.refresh: ${safeWidgetId}_icon${i}`);
                    entries.push(`                  - lvgl.widget.refresh: ${safeWidgetId}_temp${i}`);
                }
            });
        } else if (displayId) {
            entries.push(`                  - component.update: ${displayId}`);
        }
        entries.push(`                on_error:`);
        entries.push(`                  - logger.log:`);
        entries.push(`                      level: WARN`);
        entries.push(`                      format: "weather.get_forecasts failed for ${group.entity}: %s"`);
        entries.push(`                      args: ["error.c_str()"]`);
    });

    insertTopLevelSectionEntries(
        lines,
        'interval',
        entries,
        '# Weather Forecast Update Loop (on-device weather.get_forecasts action calls; requires ESPHome >= 2025.10, HA Core >= 2025.11, and the HA option "Allow the device to perform Home Assistant actions")'
    );
};
