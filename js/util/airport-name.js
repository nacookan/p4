// 空港名の略称化。「大阪（伊丹）」のようにカッコ書きがある場合はカッコ内（「伊丹」）を、
// カッコ書きが無い場合（「仙台」等）はそのままの名前を略称として使う。
export function abbreviateAirport(name) {
  const m = /^(.*)（(.*)）$/.exec(name);
  return m ? m[2] : name;
}
