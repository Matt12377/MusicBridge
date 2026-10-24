const SIGNED_64_MIN=-(1n<<63n),UNSIGNED_64_MAX=(1n<<64n)-1n

/** Node/SMB可能把同一64位inode按有符号值回报；只接受精确有界、无别名的十进制表示。 */
export function isCanonicalNodeStatInode(value:unknown):value is string {
  if(typeof value!=='string'||!/^(?:0|[1-9][0-9]{0,19}|-[1-9][0-9]{0,18})$/u.test(value))return false
  const integer=BigInt(value)
  return integer>=SIGNED_64_MIN&&integer<=UNSIGNED_64_MAX
}

/** Native的ino_t回显固定为u64；不能接受负数、溢出或前导零。 */
export function isCanonicalUnsignedStatInode(value:unknown):value is string {
  return isCanonicalNodeStatInode(value)&&value[0]!=='-'
}

/** 仅在比对Native原始回显时转换；Main/Owner的FD与命名空间pin仍保Node原表示。 */
export function nodeStatInodeAsUnsignedDecimal(value:string|bigint):string {
  const decimal=typeof value==='bigint'?value.toString():value
  if(!isCanonicalNodeStatInode(decimal))throw new RangeError('目录inode不在原64位表示范围内。')
  return BigInt.asUintN(64,BigInt(decimal)).toString()
}
