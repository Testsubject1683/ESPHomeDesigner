import { describe, expect, it, vi } from 'vitest';

vi.mock('../../js/utils/logger.js', () => ({
    Logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() }
}));

import { registry } from '../../js/core/plugin_registry';
import { ESPHomeAdapter } from '../../js/io/adapters/esphome_adapter';
import { generatePageSelectSection } from '../../js/io/hardware_generators_inputs.js';
import textPlugin from '../../features/text/plugin.js';

const textWidget = (id, text) => ({
    id, type: 'text', x: 5, y: 5, width: 100, height: 30,
    props: { ...textPlugin.defaults, text }
});

const layoutWithPages = (model, pageNames) => ({
    name: 't',
    deviceName: 'dev',
    deviceModel: model,
    currentLayoutId: 'l1',
    settings: { renderingMode: 'direct', orientation: 'landscape', darkMode: false },
    pages: pageNames.map((name, i) => ({ id: `p${i}`, name, widgets: [textWidget(`w${i}`, name)] }))
});

describe('generatePageSelectSection', () => {
    it('emits nothing for a single page', () => {
        expect(generatePageSelectSection([{ name: 'Only' }])).toEqual([]);
        expect(generatePageSelectSection([])).toEqual([]);
        expect(generatePageSelectSection(null)).toEqual([]);
    });

    it('emits a select with page names as options and change_page_to wiring', () => {
        const lines = generatePageSelectSection([{ name: 'Home' }, { name: 'Stats' }, {}]);
        const out = lines.join('\n');

        expect(out).toContain('select:');
        expect(out).toContain('id: page_select');
        expect(out).toContain('name: "Display Page"');
        expect(out).toContain('- "Home"');
        expect(out).toContain('- "Stats"');
        expect(out).toContain('- "Page 3"');
        expect(out).toContain('const char* page_names[] = {"Home", "Stats", "Page 3"};');
        expect(out).toContain('if (p < 0 || p >= 3) return {};');
        expect(out).toContain('return page_names[p];');
        expect(out).toContain('id(change_page_to).execute(i);');
        expect(out).toContain('id(page_select).update();');
    });

    it('escapes quotes and backslashes in page names for C and YAML', () => {
        const out = generatePageSelectSection([{ name: 'A "quoted" \\ page' }, { name: 'B' }]).join('\n');
        expect(out).toContain('"A \\"quoted\\" \\\\ page"');
        expect(out).toContain('- "A \\"quoted\\" \\\\ page"');
    });
});

describe('page select in exported YAML', () => {
    it('includes the select with page names for multi-page layouts', async () => {
        registry.register(textPlugin);
        const adapter = new ESPHomeAdapter();
        const yaml = await adapter.generate(layoutWithPages('reterminal_e1001', ['Home', 'Second']));

        expect(yaml).toContain('\nselect:');
        expect(yaml).toContain('id: page_select');
        expect(yaml).toContain('- "Home"');
        expect(yaml).toContain('- "Second"');
        expect(yaml).toContain('id(change_page_to).execute(i);');
        expect(yaml).toContain('\nbutton:');
        expect(yaml).toContain('Next Page');
    });

    it('emits the select for package-based profiles too (GeekMagic Mini)', async () => {
        registry.register(textPlugin);
        const adapter = new ESPHomeAdapter();
        adapter.fetchHardwarePackage = async () => 'display:\n  - platform: mipi_spi\n    id: epaper_display\n';
        const yaml = await adapter.generate(layoutWithPages('geekmagic_mini_esp8266', ['Home', 'Second']));

        expect(yaml).toContain('\nselect:');
        expect(yaml).toContain('id: page_select');
        expect(yaml).toContain('- "Home"');
        expect(yaml).toContain('\nbutton:');
        expect(yaml).toContain('Next Page');
    });

    it('skips generated buttons when the hardware package already defines button:', async () => {
        registry.register(textPlugin);
        const adapter = new ESPHomeAdapter();
        adapter.fetchHardwarePackage = async () => 'button:\n  - platform: template\n    name: "Custom"\n';
        const yaml = await adapter.generate(layoutWithPages('geekmagic_mini_esp8266', ['Home', 'Second']));

        expect(yaml).toContain('\nselect:');
        expect(yaml).toContain('id: page_select');
        expect(yaml).not.toContain('Next Page');
        expect(yaml.match(/^button:/gm)).toHaveLength(1);
        expect(yaml).toContain('name: "Custom"');
    });

    it('omits the select for single-page layouts', async () => {
        registry.register(textPlugin);
        const adapter = new ESPHomeAdapter();
        const yaml = await adapter.generate(layoutWithPages('reterminal_e1001', ['Only']));

        expect(yaml).not.toContain('\nselect:');
        expect(yaml).not.toContain('page_select');
    });

    it('refreshes the select inside change_page_to so on-device page changes update HA', async () => {
        registry.register(textPlugin);
        const adapter = new ESPHomeAdapter();
        const yaml = await adapter.generate(layoutWithPages('reterminal_e1001', ['Home', 'Second']));

        expect(yaml).toContain('id: change_page_to');
        expect(yaml).toMatch(/id\(display_page\) = target;\s*\n\s*id\(page_select\)\.update\(\);/);
    });

    it('does not reference page_select in change_page_to for single-page layouts', async () => {
        registry.register(textPlugin);
        const adapter = new ESPHomeAdapter();
        const yaml = await adapter.generate(layoutWithPages('reterminal_e1001', ['Only']));

        expect(yaml).not.toContain('id: change_page_to');
        expect(yaml).not.toContain('page_select');
    });
});
