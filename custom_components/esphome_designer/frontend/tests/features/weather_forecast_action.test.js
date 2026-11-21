import { describe, expect, it } from 'vitest';

import plugin from '../../features/weather_forecast/plugin.js';
import { onExportComponents, onExportGlobals } from '../../features/weather_forecast/export_actions.js';
import { onExportNumericSensors, onExportTextSensors } from '../../features/weather_forecast/export_sensors.js';
import { getForecastPlan, getWidgetDataSource, globalIdForSensor } from '../../features/weather_forecast/slot_plan.js';

const actionWidget = (overrides = {}, propsOverrides = {}) => ({
    id: 'weather-card',
    type: 'weather_forecast',
    entity_id: 'weather.home',
    props: { ...plugin.defaults, ...propsOverrides, ...overrides }
});

describe('weather_forecast esphome_action data source', () => {
    it('defaults to the on-device action source with a 1h refresh interval', () => {
        expect(plugin.defaults.data_source).toBe('esphome_action');
        expect(plugin.defaults.refresh_interval).toBe('1h');
        expect(getWidgetDataSource({ props: {} })).toBe('esphome_action');
        expect(getWidgetDataSource({ props: { data_source: 'ha_template' } })).toBe('ha_template');
    });

    it('exports local template numeric sensors instead of homeassistant platform sensors', () => {
        const lines = [];
        const seenSensorIds = new Set();
        const widget = actionWidget({}, { days: 2, start_offset: 1, temp_unit: 'F' });

        onExportNumericSensors({ lines, widgets: [widget], seenSensorIds, isLvgl: true, pendingTriggers: new Map() });
        const output = lines.join('\n');

        expect(output).toContain('# Weather Forecast Numeric Sensors (on-device action source)');
        expect(output).toContain('- platform: template');
        expect(output).toContain('id: weather_high_day1');
        expect(output).toContain('id: weather_low_day2');
        expect(output).toContain("unit_of_measurement: '°F'");
        expect(output).toContain("lambda: 'return id(weather_g_high_day1);'");
        expect(output).toContain('update_interval: never');
        expect(output).not.toContain('platform: homeassistant');

        const firstPass = output;
        onExportNumericSensors({ lines, widgets: [widget], seenSensorIds, isLvgl: true, pendingTriggers: new Map() });
        expect(lines.join('\n')).toBe(firstPass);
    });

    it('exports local template condition sensors and skips the HA template YAML comments', () => {
        const lines = [];
        const seenSensorIds = new Set();
        const widget = actionWidget({}, { forecast_mode: 'hourly', hourly_mode: 'fixed', hourly_slots: '06,09,12', start_offset: 1 });

        onExportTextSensors({ lines, seenSensorIds, widgets: [widget] });
        const output = lines.join('\n');

        expect(output).toContain('# Weather Forecast Condition Sensors (on-device action source)');
        expect(output).toContain('id: weather_cond_h0900');
        expect(output).toContain('id: weather_cond_h1200');
        expect(output).not.toContain('id: weather_cond_h0600');
        expect(output).toContain("lambda: 'return id(weather_g_cond_h0900);'");
        expect(output).not.toContain('HOME ASSISTANT TEMPLATE SENSORS');
        expect(output).not.toContain('default_entity_id');
        expect(output).not.toContain('platform: homeassistant');
    });

    it('keeps the legacy HA template sensor flow when data_source is ha_template', () => {
        const lines = [];
        const seenSensorIds = new Set();
        const widget = actionWidget({}, { data_source: 'ha_template', days: 1 });

        onExportTextSensors({ lines, seenSensorIds, widgets: [widget] });
        const output = lines.join('\n');

        expect(output).toContain('- platform: homeassistant');
        expect(output).toContain('entity_id: sensor.weather_forecast_day_0_condition');
        expect(output).toContain('HOME ASSISTANT TEMPLATE SENSORS (DAILY)');
        expect(output).not.toContain('platform: template');
    });

    it('emits one global per slot value and deduplicates across widgets', () => {
        const lines = [];
        const widgetA = actionWidget({}, { days: 2 });
        const widgetB = actionWidget({ id: 'weather-second' }, { days: 2 });

        onExportGlobals({ lines, widgets: [widgetA, widgetB] });
        const output = lines.join('\n');

        expect(output).toContain('- id: weather_g_high_day0');
        expect(output).toContain('- id: weather_g_low_day0');
        expect(output).toContain('- id: weather_g_cond_day0');
        expect(output).toContain("type: float");
        expect(output).toContain("type: std::string");
        expect(output).toContain("initial_value: 'NAN'");
        expect(output).toContain("initial_value: '\"\"'");
        expect(lines.filter(l => l === '- id: weather_g_high_day0')).toHaveLength(1);
        expect(lines.filter(l => l === '- id: weather_g_cond_day1')).toHaveLength(1);
        expect(globalIdForSensor('weather_high_h0900')).toBe('weather_g_high_h0900');
    });

    it('emits a periodic homeassistant.action interval with response parsing and refresh actions', () => {
        const lines = [];
        const widget = actionWidget({}, { days: 2, refresh_interval: '30min' });

        onExportComponents({ lines, widgets: [widget], displayId: 'my_display', isLvgl: false });
        const output = lines.join('\n');

        expect(output).toContain('interval:');
        expect(output).toContain('- interval: 30min');
        expect(output).toContain('- homeassistant.action:');
        expect(output).toContain('action: weather.get_forecasts');
        expect(output).toContain('entity_id: weather.home');
        expect(output).toContain('type: daily');
        expect(output).toContain('capture_response: true');
        expect(output).toContain('on_success:');
        expect(output).toContain('JsonArrayConst fc = doc.as<JsonArrayConst>();');
        expect(output).toContain('deserializeJson(doc, response["response"].as<const char*>())');
        expect(output).toContain('response_template: >-');
        expect(output).toContain("response['weather.home']['forecast']");
        expect(output).toContain('tojson');
        expect(output).toContain('if (fc.isNull()) {');
        expect(output).not.toContain('is<JsonArray>()');
        expect(output).toContain('No forecast array for weather.home');
        expect(output).toContain('response_empty=%d has_response_key=%d');
        expect(output).toContain('HA Core >= 2025.11');
        expect(output).toContain('id(weather_g_high_day0) = getf(e[1]);');
        expect(output).toContain('id(weather_g_low_day1) = getf(e[2]);');
        expect(output).toContain('id(weather_g_cond_day0) = std::string(e[3] | "");');
        expect(output).toContain('- component.update: weather_high_day0');
        expect(output).toContain('- component.update: weather_cond_day1');
        expect(output).toContain('- component.update: my_display');
        expect(output).toContain('on_error:');
        expect(output).toContain('weather.get_forecasts failed for weather.home: %s');
        expect(output).not.toContain('lvgl.widget.refresh');
    });

    it('refreshes LVGL sub-widgets instead of the display when in LVGL mode', () => {
        const lines = [];
        const widget = actionWidget({}, { days: 1 });

        onExportComponents({ lines, widgets: [widget], displayId: 'my_display', isLvgl: true });
        const output = lines.join('\n');

        expect(output).toContain('- lvgl.widget.refresh: weather_card_day0');
        expect(output).toContain('- lvgl.widget.refresh: weather_card_icon0');
        expect(output).toContain('- lvgl.widget.refresh: weather_card_temp0');
        expect(output).toContain('- component.update: weather_high_day0');
        expect(output).not.toContain('- component.update: my_display');
    });

    it('groups widgets by entity and forecast type and maps hourly slots by timestamp', () => {
        const lines = [];
        const daily = actionWidget({}, { days: 1 });
        const hourly = actionWidget({ id: 'weather-hourly' }, {
            forecast_mode: 'hourly',
            hourly_mode: 'relative',
            relative_count: 2
        });
        const sameHourly = actionWidget({ id: 'weather-hourly-2' }, {
            forecast_mode: 'hourly',
            hourly_mode: 'relative',
            relative_count: 2
        });

        onExportComponents({ lines, widgets: [daily, hourly, sameHourly], displayId: 'd', isLvgl: false });
        const output = lines.join('\n');

        expect(lines.filter(l => l.trim() === '- interval: 1h')).toHaveLength(2);
        expect(output).toContain('type: daily');
        expect(output).toContain('type: hourly');
        expect(output).toContain('time_t target = base_hour + 2 * 3600;');
        expect(output).toContain('id(weather_g_high_hplus2) = getf(e[1]);');
        expect(output).toContain('ESPTime::strptime(norm, et)');
        expect(lines.filter(l => l.includes('action: weather.get_forecasts'))).toHaveLength(2);
    });

    it('maps fixed hourly slots to today-or-tomorrow wall-clock targets', () => {
        const plan = getForecastPlan(actionWidget({}, {
            forecast_mode: 'hourly',
            hourly_mode: 'fixed',
            hourly_slots: '06,09',
            start_offset: 0
        }));
        expect(plan.slots.map(s => s.highId)).toEqual(['weather_high_h0600', 'weather_high_h0900']);

        const lines = [];
        onExportComponents({ lines, widgets: [actionWidget({}, {
            forecast_mode: 'hourly',
            hourly_mode: 'fixed',
            hourly_slots: '09'
        })], displayId: 'd', isLvgl: false });
        const output = lines.join('\n');
        expect(output).toContain('time_t target = day_start + 9 * 3600;');
        expect(output).toContain('if (now_ts > target + 3600) target += 86400;');
        expect(output).toContain('id(weather_g_high_h0900) = getf(e[1]);');
    });

    it('parses ISO datetime offsets so non-UTC forecast timestamps still match', () => {
        const lines = [];
        onExportComponents({ lines, widgets: [actionWidget({}, {
            forecast_mode: 'hourly',
            hourly_mode: 'relative',
            relative_count: 1
        })], displayId: 'd', isLvgl: false });
        const output = lines.join('\n');

        expect(output).toContain('et.recalc_timestamp_utc(false);');
        expect(output).toContain("if (dt.size() > 19 && (dt[19] == '+' || dt[19] == '-')) {");
        expect(output).toContain("int sign = dt[19] == '-' ? -1 : 1;");
        expect(output).toContain('ts -= (time_t) sign * (oh * 3600 + om * 60);');
    });

    it('logs a diagnostic when the hourly forecast array is non-empty but no slot matches', () => {
        const lines = [];
        onExportComponents({ lines, widgets: [actionWidget({}, {
            forecast_mode: 'hourly',
            hourly_mode: 'relative',
            relative_count: 2
        })], displayId: 'd', isLvgl: false });
        const output = lines.join('\n');

        expect(output).toContain('int matched = 0;');
        expect(output).toContain('matched++;');
        expect(output).toContain('if (matched == 0 && fc.size() > 0) {');
        expect(output).toContain('ESP_LOGW("weather", "hourly: no forecast entry matched for weather.home (entries=%d first_datetime=%s)"');
    });

    it('does not emit hourly timestamp matching for daily-only widgets', () => {
        const lines = [];
        onExportComponents({ lines, widgets: [actionWidget({}, { days: 2 })], displayId: 'd', isLvgl: false });
        const output = lines.join('\n');

        expect(output).not.toContain('parse_ts');
        expect(output).not.toContain('int matched = 0;');
        expect(output).not.toContain('hourly: no forecast entry matched');
        expect(output).toContain('if (0 < fc.size()) {');
    });

    it('falls back to the first forecast entry when ha_time is not synced, and logs a summary', () => {
        const lines = [];
        onExportComponents({ lines, widgets: [actionWidget({}, {
            forecast_mode: 'hourly',
            hourly_mode: 'relative',
            relative_count: 1
        })], displayId: 'd', isLvgl: false });
        const output = lines.join('\n');

        expect(output).toContain('time_t now_ts = t.is_valid() ? t.timestamp : (time_t) -1;');
        expect(output).toContain('now_ts = parse_ts(std::string(fc[0][0] | ""));');
        expect(output).toContain('ESP_LOGW("weather", "hourly: ha_time not synced for weather.home; anchoring to first forecast entry (ts=%d)"');
        expect(output).toContain('ESP_LOGW("weather", "hourly: no valid time and no parsable forecast datetime for weather.home; skipping parse");');
        expect(output).toContain('ESP_LOGI("weather", "hourly parse weather.home: entries=%d matched=%d have_time=%d"');
        expect(output).toContain('time_t base_hour = (now_ts / 3600) * 3600;');
        expect(output).not.toContain('if (!t.is_valid()) return;');
    });

    it('emits an HA-side response_template that compacts each forecast entry to 4 fields', () => {
        const lines = [];
        onExportComponents({ lines, widgets: [actionWidget({}, { forecast_mode: 'hourly', hourly_mode: 'relative', relative_count: 1 })], displayId: 'd', isLvgl: false });
        const output = lines.join('\n');

        expect(output).toContain('response_template: >-');
        expect(output).toContain("{% set fc = response['weather.home']['forecast'] %}");
        expect(output).toContain("out.append([e.get('datetime'), e.get('temperature'), e.get('templow'), e.get('condition')])");
        expect(output).toContain('{{ out | tojson }}');
        expect(output).toContain('capture_response: true');
        // hourly lambda reads the compacted array by index
        expect(output).toContain('parse_ts(std::string(e[0] | "")) == target');
        expect(output).toContain('getf(e[1])');
        expect(output).toContain('std::string(e[3] | "")');
    });
});
