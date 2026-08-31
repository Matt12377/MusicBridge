/** Unknown 只补展示文案；不回写原字段，也不参与型号身份匹配。 */
export function collectionModelLabel(model: { readonly brand: string; readonly name: string }): string {
  const brand = model.brand.trim(), name = model.name.trim()
  return brand && name ? `${model.brand} ${model.name}` : `${brand || '品牌待确认'} · ${name || '型号待确认'}`
}

/** 不放宽手工入库合同；导入的缺失描述只能走可追溯的源行数量更正。 */
export function canManuallyReceiveModel(model: { readonly brand: string; readonly name: string; readonly identification: string }): boolean {
  return !!model.brand.trim() && !!model.name.trim() && model.identification !== 'partial'
}
