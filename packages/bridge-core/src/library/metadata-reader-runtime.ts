import type { parseFromTokenizer } from 'music-metadata';

/** 静态部分只定义函数；第三方模块初始化必须在Worker安装分配守卫后调用。 */
export async function loadMetadataEndOfStreamError(): Promise<new () => Error> {
  const { EndOfStreamError } = await import('strtok3');
  return EndOfStreamError;
}
export async function loadMetadataParser(): Promise<typeof parseFromTokenizer> {
  const { parseFromTokenizer: parse } = await import('music-metadata');
  return parse;
}
