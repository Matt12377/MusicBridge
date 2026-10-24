use std::io::{self, Read, Seek, SeekFrom};

/// 只借用当前作业的源与已核 RIFF 兼容 LIST 偏移及终端补齐位置；不改源、缓存或定位语义。
pub struct WaveTagView<'a, R> {
    reader: &'a mut R,
    hidden_lists: &'a [u64],
    tail_at: Option<u64>,
    tail_consumed: bool,
}

impl<'a, R> WaveTagView<'a, R> {
    #[cfg(test)]
    pub fn new(reader: &'a mut R, hidden_lists: &'a [u64]) -> Self { Self::with_tail(reader, hidden_lists, None) }
    pub fn with_tail(reader: &'a mut R, hidden_lists: &'a [u64], tail_at: Option<u64>) -> Self { Self { reader, hidden_lists, tail_at, tail_consumed: false } }
}

impl<R: Read + Seek> Read for WaveTagView<'_, R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if buffer.is_empty() || self.tail_consumed { return Ok(0); }
        let begin = self.reader.stream_position()?;
        let mut count = self.reader.read(buffer)?;
        let end = begin.saturating_add(count as u64);
        let first = self.hidden_lists.partition_point(|offset| offset.saturating_add(4) <= begin);
        for &offset in &self.hidden_lists[first..] {
            if offset >= end { break; }
            let from = begin.max(offset);
            let to = end.min(offset + 4);
            // Lofty 无条件拒绝 size<4 的 LIST；仅把已核 size==0 的占位标识映射为同长 JUNK。
            buffer[(from - begin) as usize..(to - begin) as usize]
                .copy_from_slice(&b"JUNK"[(from - offset) as usize..(to - offset) as usize]);
        }
        if self.tail_at == Some(end) && count < buffer.len() { buffer[count] = 0; count += 1; self.tail_consumed = true; }
        Ok(count)
    }
}

impl<R: Seek> Seek for WaveTagView<'_, R> {
    fn seek(&mut self, from: SeekFrom) -> io::Result<u64> {
        let Some(size) = self.tail_at else { return self.reader.seek(from); };
        let position = self.reader.stream_position()? + u64::from(self.tail_consumed);
        let target = match from { SeekFrom::Start(at) => i128::from(at), SeekFrom::Current(delta) => i128::from(position) + i128::from(delta), SeekFrom::End(delta) => i128::from(size) + 1 + i128::from(delta) };
        if target < 0 || target > i128::from(size) + 1 { return Err(io::Error::new(io::ErrorKind::InvalidInput, "标签视图定位越界")); }
        let at = target as u64;
        self.reader.seek(SeekFrom::Start(at.min(size)))?; self.tail_consumed = at > size; Ok(at)
    }
}

#[cfg(test)]
mod tests {
    use super::WaveTagView;
    use std::io::{Cursor, Read, Seek, SeekFrom};

    #[test]
    fn partial_reads_only_replace_the_fourcc_and_never_change_source() {
        let original = b"aaaLIST....bbbLIST....ccc";
        for width in [1, 2, 3, 4, 7, 64] {
            let mut source = Cursor::new(original.to_vec());
            let mut view = WaveTagView::new(&mut source, &[3, 14]);
            let mut actual = Vec::new();
            let mut buffer = vec![0; width];
            loop { let count = view.read(&mut buffer).unwrap(); if count == 0 { break; } actual.extend_from_slice(&buffer[..count]); }
            assert_eq!(actual, b"aaaJUNK....bbbJUNK....ccc");
            assert_eq!(source.get_ref(), original);
        }
    }

    #[test]
    fn seeks_keep_the_original_positions_even_inside_a_fourcc() {
        let original = b"aaaLIST....bbbLIST....ccc";
        let mut source = Cursor::new(original.to_vec());
        let mut view = WaveTagView::new(&mut source, &[3, 14]);
        let mut two = [0; 2];
        assert_eq!(view.seek(SeekFrom::Start(4)).unwrap(), 4);
        view.read_exact(&mut two).unwrap(); assert_eq!(&two, b"UN");
        assert_eq!(view.seek(SeekFrom::End(-9)).unwrap(), 16);
        view.read_exact(&mut two).unwrap(); assert_eq!(&two, b"NK");
        assert_eq!(view.seek(SeekFrom::Current(-15)).unwrap(), 3);
        view.read_exact(&mut two).unwrap(); assert_eq!(&two, b"JU");
        assert_eq!(source.get_ref(), original);
    }

    #[test]
    fn no_verified_offsets_preserves_every_original_byte() {
        let original = b"LIST....";
        let mut source = Cursor::new(original.to_vec());
        let mut view = WaveTagView::new(&mut source, &[]);
        let mut actual = Vec::new(); view.read_to_end(&mut actual).unwrap();
        assert_eq!(actual, original);
        assert_eq!(source.get_ref(), original);
    }

    #[test]
    fn verified_tail_is_one_logical_byte_with_repeatable_seeks() {
        let mut source = Cursor::new(b"abc".to_vec());
        {
            let mut view = WaveTagView::with_tail(&mut source, &[], Some(3));
            assert_eq!(view.seek(SeekFrom::End(0)).unwrap(), 4);
            assert_eq!(view.seek(SeekFrom::Start(2)).unwrap(), 2);
            let mut bytes = [9; 4];
            assert_eq!(view.read(&mut bytes).unwrap(), 2);
            assert_eq!(&bytes[..2], b"c\0");
            assert_eq!(view.stream_position().unwrap(), 4);
            assert_eq!(view.read(&mut bytes).unwrap(), 0);
            assert_eq!(view.seek(SeekFrom::Current(-1)).unwrap(), 3);
            assert_eq!(view.read(&mut []).unwrap(), 0);
            assert_eq!(view.read(&mut bytes).unwrap(), 1);
            assert_eq!(bytes[0], 0);
            assert!(view.seek(SeekFrom::Start(5)).is_err());
            assert!(view.seek(SeekFrom::End(-5)).is_err());
            assert_eq!(view.seek(SeekFrom::End(-4)).unwrap(), 0);
            let mut all = Vec::new(); view.read_to_end(&mut all).unwrap();
            assert_eq!(all, b"abc\0");
        }
        assert_eq!(source.get_ref(), b"abc");
        assert_eq!(source.stream_position().unwrap(), 3);
    }

    #[test]
    fn partial_reads_combine_verified_list_patch_and_one_tail_without_source_writes() {
        for width in [1, 2, 3, 4, 7] {
            let mut source = Cursor::new(b"aaaLIST".to_vec());
            {
                let mut view = WaveTagView::with_tail(&mut source, &[3], Some(7));
                let mut actual = Vec::new(); let mut buffer = vec![0; width];
                loop { let n = view.read(&mut buffer).unwrap(); if n == 0 { break; } actual.extend_from_slice(&buffer[..n]); }
                assert_eq!(actual, b"aaaJUNK\0");
            }
            assert_eq!(source.get_ref(), b"aaaLIST");
        }
    }
}
