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
    body.push(`JsonVariantConst data = response["response"];`);
    body.push(`if (data.isNull()) data = response;`);
    body.push(`JsonVariantConst fc = data["${entity}"]["forecast"];`);
    body.push(`if (!fc.is<JsonArray>()) { ESP_LOGW("weather", "No forecast array in response for ${entity}"); return; }`);
    body.push(`auto getf = [](JsonVariantConst v) -> float { return v.isNull() ? NAN : v.as<float>(); };`);

    if (type === "daily") {
        slots.forEach(slot => {
            if (slot.kind.type !== "daily") return;
            const d = slot.kind.dayIndex;
            body.push(`if (${d} < fc.size()) {`);
            body.push(`  JsonVariantConst e = fc[${d}];`);
            body.push(`  id(${globalIdForSensor(slot.highId)}) = getf(e["temperature"]);`);
            body.push(`  id(${globalIdForSensor(slot.lowId)}) = getf(e["templow"]);`);
            body.push(`  id(${globalIdForSensor(slot.condId)}) = std::string(e["condition"] | "");`);
            body.push(`}`);
        });
        return body;
    }

    body.push(`auto t = id(ha_time).now();`);
    body.push(`if (!t.is_valid()) return;`);
    body.push(`time_t base_hour = (t.timestamp / 3600) * 3600;`);
    body.push(`time_t day_start = t.timestamp - ((time_t) t.hour * 3600 + (time_t) t.minute * 60 + t.second);`);
    body.push(`auto parse_ts = [](const std::string &dt) -> time_t {`);
    body.push(`  if (dt.size() < 19) return (time_t) -1;`);
    body.push(`  std::string norm = dt.substr(0, 19);`);
    body.push(`  norm[10] = ' ';`);
    body.push(`  ESPTime et{};`);
    body.push(`  if (!ESPTime::strptime(norm, et)) return (time_t) -1;`);
    body.push(`  et.recalc_timestamp_utc(false);`);
    body.push(`  return et.timestamp;`);
    body.push(`};`);

    slots.forEach(slot => {
        if (slot.kind.type !== "hourly") return;
        body.push(`{`);
        if (slot.kind.relative) {
            body.push(`  time_t target = base_hour + ${slot.kind.hoursAhead} * 3600;`);
        } else {
            body.push(`  time_t target = day_start + ${slot.kind.hour} * 3600;`);
            body.push(`  if (t.timestamp > target + 3600) target += 86400;`);
        }
        body.push(`  for (JsonVariantConst e : fc) {`);
        body.push(`    if (parse_ts(std::string(e["datetime"] | "")) == target) {`);
        body.push(`      id(${globalIdForSensor(slot.highId)}) = getf(e["temperature"]);`);
        body.push(`      id(${globalIdForSensor(slot.condId)}) = std::string(e["condition"] | "");`);
        body.push(`      break;`);
        body.push(`    }`);
        body.push(`  }`);
        body.push(`}`);
    });
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
        '# Weather Forecast Update Loop (on-device weather.get_forecasts action calls; requires ESPHome >= 2025.10 and the HA option "Allow the device to perform Home Assistant actions")'
    );
};
