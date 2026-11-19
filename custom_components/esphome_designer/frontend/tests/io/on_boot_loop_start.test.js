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

describe('on_boot starts the refresh/auto-cycle loop', () => {
    it('emits an active on_boot that starts manage_run_and_sleep', async () => {
        registry.register(textPlugin);
        const adapter = new ESPHomeAdapter();
        const yaml = await adapter.generate(twoPageLayout('reterminal_e1001'));

        expect(yaml).toContain('\non_boot:');
        expect(yaml).toContain('- script.execute: manage_run_and_sleep');
        expect(yaml).toContain("lambda: 'return !id(manage_run_and_sleep).is_running();'");
        expect(yaml).toContain('- id: auto_cycle_timer');
    });

    it('emits on_boot for package-based profiles whose recipe has none (GeekMagic Mini)', async () => {
        registry.register(textPlugin);
        const adapter = new ESPHomeAdapter();
        adapter.fetchHardwarePackage = async () => 'display:\n  - platform: mipi_spi\n    id: epaper_display\n';
        const yaml = await adapter.generate(twoPageLayout('geekmagic_mini_esp8266'));

        expect(yaml.match(/^on_boot:/gm)).toHaveLength(1);
        expect(yaml).toContain('- script.execute: manage_run_and_sleep');
    });

    it('does not duplicate on_boot when the hardware package already defines one', async () => {
        registry.register(textPlugin);
        const adapter = new ESPHomeAdapter();
        adapter.fetchHardwarePackage = async () => 'on_boot:\n  priority: 600\n  then:\n    - script.execute: manage_run_and_sleep\n';
        const yaml = await adapter.generate(twoPageLayout('geekmagic_mini_esp8266'));

        expect(yaml.match(/^on_boot:/gm)).toHaveLength(1);
    });
});
