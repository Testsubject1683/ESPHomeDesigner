import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockAppState, haFetchMock } = vi.hoisted(() => ({
    mockAppState: {
        entityStates: {},
        updateWidget: vi.fn()
    },
    haFetchMock: vi.fn()
}));

vi.mock('@core/state', () => ({
    AppState: mockAppState
}));

vi.mock('../../js/utils/env.js', () => ({
    hasHaBackend: () => true,
    HA_API_BASE: '/api'
}));

vi.mock('../../js/io/ha_api.js', () => ({
    haFetch: haFetchMock,
    getHaHeaders: () => ({ 'Content-Type': 'application/json' })
}));

import { render } from '../../features/weather_forecast/render.js';

const tools = { getColorStyle: () => 'black' };

/**
 * @param {Date} d
 * @returns {string}
 */
const toHaDatetime = (d) => d.toISOString();

/**
 * @param {number} hour local wall-clock hour
 * @returns {Date}
 */
const todayAt = (hour) => {
    const d = new Date();
    d.setHours(hour, 0, 0, 0);
    return d;
};

/**
 * @param {number} hoursAhead
 * @returns {Date}
 */
const hoursAheadTruncated = (hoursAhead) => {
    const now = new Date();
    const target = new Date(now.getTime());
    target.setMinutes(0, 0, 0);
    target.setHours(target.getHours() + hoursAhead);
    return target;
};

/**
 * @param {any[]} forecast
 * @param {string} entity
 */
const mockForecastResponse = (forecast, entity) => {
    haFetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ response: { [entity]: { forecast } } })
    });
};

/**
 * @param {string} entity
 * @param {Record<string, any>} props
 * @returns {HTMLElement}
 */
const renderWidget = (entity, props) => {
    const el = document.createElement('div');
    const widget = {
        id: 'weather_preview',
        type: 'weather_forecast',
        entity_id: entity,
        x: 0, y: 0, width: 370, height: 90,
        props
    };
    render(el, widget, tools);
    return el;
};

/**
 * @param {HTMLElement} el
 * @param {string} entity
 * @param {Record<string, any>} props
 */
const rerenderWidget = (el, entity, props) => {
    render(el, {
        id: 'weather_preview',
        type: 'weather_forecast',
        entity_id: entity,
        x: 0, y: 0, width: 370, height: 90,
        props
    }, tools);
};

describe('weather_forecast action-mode editor preview', () => {
    beforeEach(() => {
        mockAppState.entityStates = {};
        haFetchMock.mockReset();
        document.body.innerHTML = '';
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('fetches the daily forecast via the HA service and renders cached values', async () => {
        mockForecastResponse([
            { datetime: toHaDatetime(todayAt(0)), condition: 'sunny', temperature: 20.5, templow: 10.1 },
            { datetime: toHaDatetime(todayAt(0)), condition: 'rainy', temperature: 15, templow: 8 }
        ], 'weather.daily');

        const props = { days: 2, precision: 1 };
        const el = renderWidget('weather.daily', props);

        await vi.waitFor(() => expect(haFetchMock).toHaveBeenCalledTimes(1));
        expect(haFetchMock.mock.calls[0][0]).toBe('/api/services/weather/get_forecasts');
        expect(JSON.parse(haFetchMock.mock.calls[0][1].body)).toEqual({
            entity_id: 'weather.daily',
            type: 'daily',
            return_response: true
        });

        await vi.waitFor(() => {
            rerenderWidget(el, 'weather.daily', props);
            expect(el.textContent).toContain('20.5°C/10.1°C');
            expect(el.textContent).toContain('15.0°C/8.0°C');
        });
    });

    it('renders fixed hourly slots matched by wall-clock timestamp', async () => {
        const now = new Date();
        let target = todayAt((now.getHours() + 2) % 24);
        if (now.getTime() > target.getTime() + 3600 * 1000) target = new Date(target.getTime() + 86400 * 1000);
        const slotHour = target.getHours();

        mockForecastResponse([
            { datetime: toHaDatetime(target), condition: 'cloudy', temperature: 12.4 }
        ], 'weather.fixed');

        const props = {
            forecast_mode: 'hourly',
            hourly_mode: 'fixed',
            hourly_slots: String(slotHour),
            start_offset: 0,
            precision: 1
        };
        const el = renderWidget('weather.fixed', props);

        await vi.waitFor(() => expect(haFetchMock).toHaveBeenCalledTimes(1));
        expect(JSON.parse(haFetchMock.mock.calls[0][1].body).type).toBe('hourly');

        await vi.waitFor(() => {
            rerenderWidget(el, 'weather.fixed', props);
            expect(el.textContent).toContain('12.4°C');
        });
    });

    it('renders relative hourly slots matched by truncated hour offset', async () => {
        mockForecastResponse([
            { datetime: toHaDatetime(hoursAheadTruncated(1)), condition: 'sunny', temperature: 14.7 },
            { datetime: toHaDatetime(hoursAheadTruncated(2)), condition: 'rainy', temperature: 12.4 }
        ], 'weather.rel');

        const props = {
            forecast_mode: 'hourly',
            hourly_mode: 'relative',
            relative_count: 2,
            precision: 1
        };
        const el = renderWidget('weather.rel', props);

        await vi.waitFor(() => {
            rerenderWidget(el, 'weather.rel', props);
            expect(el.textContent).toContain('14.7°C');
            expect(el.textContent).toContain('12.4°C');
        });
    });

    it('shows placeholders for slots missing from the forecast and does not fetch in legacy mode', async () => {
        mockForecastResponse([
            { datetime: toHaDatetime(todayAt(0)), condition: 'sunny', temperature: 20.5, templow: 10.1 }
        ], 'weather.miss');

        const props = { days: 3, precision: 1 };
        const el = renderWidget('weather.miss', props);

        await vi.waitFor(() => {
            rerenderWidget(el, 'weather.miss', props);
            expect(el.textContent).toContain('20.5°C/10.1°C');
            expect(el.textContent).toContain('--/--');
        });

        haFetchMock.mockClear();
        renderWidget('weather.legacy', { data_source: 'ha_template', days: 2 });
        await new Promise(r => setTimeout(r, 20));
        expect(haFetchMock).not.toHaveBeenCalled();
    });

    it('falls back to legacy HA entity states when no forecast was fetched', () => {
        mockAppState.entityStates = {
            'sensor.weather_forecast_day_0_condition': { state: 'sunny' },
            'sensor.weather_forecast_day_0_high': { state: '21' },
            'sensor.weather_forecast_day_0_low': { state: '11' }
        };
        haFetchMock.mockResolvedValue({ ok: false, json: async () => ({}) });

        const el = renderWidget('weather.legacy', { days: 1, precision: 0 });
        expect(el.textContent).toContain('21°C/11°C');
    });
});
