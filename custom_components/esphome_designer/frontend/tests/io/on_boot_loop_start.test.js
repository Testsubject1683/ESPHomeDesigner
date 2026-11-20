import { describe, expect, it, vi } from 'vitest';

vi.mock('../../js/utils/logger.js', () => ({
    Logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() }
}));

import { registry } from '../../js/core/plugin_registry';
import { ESPHomeAdapter } from '../../js/io/adapters/esphome_adapter';
import textPlugin from '../../features/text/plugin.js';

const twoPageLayout = (model) => ({
    name: 't',
    deviceName: 'dev',
    deviceModel: model,
    currentLayoutId: 'l1',
    autoCycleEnabled: true,
    autoCycleIntervalS: 30,
    settings: { renderingMode: 'direct', orientation: 'landscape', darkMode: false },
    pages: [
        { id: 'p0', name: 'Home', widgets: [{ id: 'w0', type: 'text', x: 5, y: 5, width: 100, height: 30, props: { ...textPlugin.defaults, text: 'A' } }] },
        { id: 'p1', name: 'Second', widgets: [{ id: 'w1', type: 'text', x: 5, y: 5, width: 100, height: 30, props: { ...textPlugin.defaults, text: 'B' } }] }
    ]
});

const bootStarterEntries = [
    '  - interval: 30s',
    '    startup_delay: 2s',
    "            lambda: 'return !id(manage_run_and_sleep).is_running();'",
    '            - script.execute: manage_run_and_sleep'
];

describe('interval boot starter starts the refresh/auto-cycle loop', () => {
    it('emits a top-level interval: starter (never top-level on_boot) for built-in profiles', async () => {
        registry.register(textPlugin);
        const adapter = new ESPHomeAdapter();
        const yaml = await adapter.generate(twoPageLayout('reterminal_e1001'));

        expect(yaml.match(/^interval:/gm)).toHaveLength(1);
        for (const entry of bootStarterEntries) expect(yaml).toContain(entry);
        expect(yaml).not.toMatch(/^on_boot:/m);
        expect(yaml).toContain('- id: auto_cycle_timer');
    });

    it('emits the interval starter for package-based profiles whose recipe has no on_boot (GeekMagic Mini)', async () => {
        registry.register(textPlugin);
        const adapter = new ESPHomeAdapter();
        adapter.fetchHardwarePackage = async () => 'display:\n  - platform: mipi_spi\n    id: epaper_display\n';
        const yaml = await adapter.generate(twoPageLayout('geekmagic_mini_esp8266'));

        expect(yaml.match(/^interval:/gm)).toHaveLength(1);
        for (const entry of bootStarterEntries) expect(yaml).toContain(entry);
        expect(yaml).not.toMatch(/^on_boot:/m);
        expect(yaml).toContain('- script.execute: manage_run_and_sleep');
    });

    it('merges the starter into the package interval: section without duplicating the header', async () => {
        registry.register(textPlugin);
        const adapter = new ESPHomeAdapter();
        adapter.fetchHardwarePackage = async () => 'interval:\n  - interval: 60s\n    then:\n      - logger.log: pkg tick\n';
        const yaml = await adapter.generate(twoPageLayout('geekmagic_mini_esp8266'));

        expect(yaml.match(/^interval:/gm)).toHaveLength(1);
        expect(yaml).toContain('  - interval: 60s');
        for (const entry of bootStarterEntries) expect(yaml).toContain(entry);
        expect(yaml).not.toMatch(/^on_boot:/m);
    });
});
