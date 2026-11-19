/**
 * @typedef {Widget & { props?: Record<string, any>, entity_id?: string }} WeatherForecastWidget
 *
 * @typedef {{
 *   index: number,
 *   dayIdx: number,
 *   condId: string,
 *   highId: string,
 *   lowId: string,
 *   condSid: string,
 *   highSid: string,
 *   lowSid: string,
 *   kind: { type: 'daily', dayIndex: number } | { type: 'hourly', relative: boolean, hoursAhead: number, hour: number }
 * }} ForecastSlot
 *
 * @typedef {{
 *   mode: string,
 *   hourlyMode: string,
 *   count: number,
 *   startOffset: number,
 *   actualSlots: string[],
 *   weatherEntity: string,
 *   tempUnit: string,
 *   unitSymbol: string,
 *   refreshInterval: string,
 *   dataSource: string,
 *   slots: ForecastSlot[]
 * }} ForecastPlan
 */

/**
 * @param {WeatherForecastWidget} w
 * @returns {'esphome_action' | 'ha_template'}
 */
export const getWidgetDataSource = (w) => {
    const ds = w.props?.data_source || "esphome_action";
    return ds === "ha_template" ? "ha_template" : "esphome_action";
};

/**
 * @param {string} sensorId
 * @returns {string}
 */
export const globalIdForSensor = (sensorId) => sensorId.replace(/^weather_/, "weather_g_");

/**
 * Computes the per-slot sensor/global id layout shared by the legacy
 * HA-template data source and the on-device ESPHome action data source.
 *
 * @param {WeatherForecastWidget} w
 * @returns {ForecastPlan}
 */
export const getForecastPlan = (w) => {
    const p = w.props || {};
    const mode = p.forecast_mode || "daily";
    const hourlyMode = p.hourly_mode === "relative" ? "relative" : "fixed";
    const relativeCount = parseInt(p.relative_count || 5, 10);
    const startOffset = parseInt(p.start_offset || 0, 10);
    /** @type {string[]} */
    const hourlySlots = String(p.hourly_slots || "06,09,12,15,18,21")
        .split(',').map(s => s.trim()).filter(Boolean);

    const actualSlots = mode === "hourly" ? hourlySlots.slice(startOffset) : [];
    const count = mode === "hourly" ? (hourlyMode === "relative" ? relativeCount : actualSlots.length) : Math.min(7, Math.max(1, parseInt(p.days, 10) || 5));

    const tempUnit = p.temp_unit || "C";
    const unitSymbol = tempUnit === "F" ? "°F" : "°C";

    /** @type {ForecastSlot[]} */
    const slots = [];
    for (let i = 0; i < count; i++) {
        const dayIdx = i + startOffset;
        /** @type {ForecastSlot} */
        let slot;
        if (mode === "hourly") {
            if (hourlyMode === "relative") {
                slot = {
                    index: i,
                    dayIdx,
                    condId: `weather_cond_hplus${i + 1}`,
                    highId: `weather_high_hplus${i + 1}`,
                    lowId: `weather_low_hplus${i + 1}`,
                    condSid: `sensor.weather_forecast_plus_${i + 1}h_condition`,
                    highSid: `sensor.weather_forecast_plus_${i + 1}h`,
                    lowSid: `sensor.weather_forecast_plus_${i + 1}h_low`,
                    kind: { type: "hourly", relative: true, hoursAhead: i + 1, hour: -1 }
                };
            } else {
                const s = actualSlots[i];
                slot = {
                    index: i,
                    dayIdx,
                    condId: `weather_cond_h${s}00`,
                    highId: `weather_high_h${s}00`,
                    lowId: `weather_low_h${s}00`,
                    condSid: `sensor.weather_forecast_hour_${s}00_condition`,
                    highSid: `sensor.weather_forecast_hour_${s}00`,
                    lowSid: `sensor.weather_forecast_hour_${s}00_low`,
                    kind: { type: "hourly", relative: false, hoursAhead: -1, hour: parseInt(s, 10) }
                };
            }
        } else {
            slot = {
                index: i,
                dayIdx,
                condId: `weather_cond_day${dayIdx}`,
                highId: `weather_high_day${dayIdx}`,
                lowId: `weather_low_day${dayIdx}`,
                condSid: `sensor.weather_forecast_day_${dayIdx}_condition`,
                highSid: `sensor.weather_forecast_day_${dayIdx}_high`,
                lowSid: `sensor.weather_forecast_day_${dayIdx}_low`,
                kind: { type: "daily", dayIndex: dayIdx }
            };
        }
        slots.push(slot);
    }

    return {
        mode,
        hourlyMode,
        count,
        startOffset,
        actualSlots,
        weatherEntity: w.entity_id || p.weather_entity || "weather.forecast_home",
        tempUnit,
        unitSymbol,
        refreshInterval: String(p.refresh_interval || "1h").trim() || "1h",
        dataSource: getWidgetDataSource(w),
        slots
    };
};
