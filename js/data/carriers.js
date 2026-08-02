export const KNOWN_CARRIERS = {
  ANA: { name: 'ANA（全日本空輸）', group: 'ana-mainline', ppEligible: true },
  AKX: { name: 'ANAウイングス', group: 'ana-mainline', ppEligible: true },
  ADO: { name: 'AIRDO（エア・ドゥ）', group: 'codeshare', ppEligible: true },
  SFJ: { name: 'スターフライヤー', group: 'codeshare', ppEligible: true },
  SNA: { name: 'ソラシドエア', group: 'codeshare', ppEligible: true },
  IBX: { name: 'IBEXエアラインズ', group: 'codeshare', ppEligible: true },
  JAC: { name: '日本エアコミューター', group: 'codeshare', ppEligible: true },
  ORC: { name: 'オリエンタルエアブリッジ', group: 'codeshare', ppEligible: true },
  AMX: { name: '天草エアライン', group: 'codeshare', ppEligible: true },
};

export function carrierInfo(code) {
  return KNOWN_CARRIERS[code] || null;
}

export function isKnownCarrier(code) {
  return Object.prototype.hasOwnProperty.call(KNOWN_CARRIERS, code);
}
