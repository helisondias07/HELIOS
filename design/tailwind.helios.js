// Uso: presets: [require('./tailwind.helios.js')] no tailwind.config
module.exports = {
  theme: {
    extend: {
      colors: {
        helios: {
          eclipse: '#0B0B0D', obsidiana: '#131316', basalto: '#1C1C21', brasa: '#2A2A31',
          nevoa: '#9A968C', marfim: '#F4EEE2',
          ouro: '#E8B23A', aurora: '#FFD878', ambar: '#C98A22', bronze: '#6E4B16',
          sucesso: '#7BC47F', alerta: '#E8833A', erro: '#E5574F',
        },
      },
      fontFamily: { marca: ['Cinzel', 'serif'], ui: ['Inter', 'system-ui', 'sans-serif'] },
      borderRadius: { controle: '10px', campo: '12px', cartao: '16px' },
      boxShadow: { solar: '0 0 0 3px rgba(232,178,58,.14), 0 0 24px rgba(232,178,58,.14)' },
    },
  },
};
