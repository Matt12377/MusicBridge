"""只读比较官方已pin ZIP与实际Electron树；不解压、不安装。"""
import hashlib
import json
import os
import pathlib
import stat
import sys
import zipfile


def digest(stream):
    h = hashlib.sha256()
    while True:
        chunk = stream.read(1024 * 1024)
        if not chunk:
            return h.hexdigest()
        h.update(chunk)


def safe_name(name):
    parts = name.rstrip('/').split('/')
    if not name or name.startswith('/') or '\\' in name or any(p in ('', '.', '..') for p in parts):
        raise ValueError('ZIP路径不规范')
    return '/'.join(parts)


def verify_tree(archive, package, expected_sha, executable):
    archive = pathlib.Path(archive)
    package = pathlib.Path(package)
    if str(archive.resolve()) != str(archive) or not archive.is_file():
        raise ValueError('ZIP必须是明确真实文件')
    if str(package.resolve()) != str(package):
        raise ValueError('Electron package必须规范真实')
    with archive.open('rb') as stream:
        if digest(stream) != expected_sha:
            raise ValueError('官方ZIP SHA不符')
    dist = package / 'dist'
    if dist.is_symlink() or not dist.is_dir():
        raise ValueError('实际dist无效')
    files, directories, identities = {}, set(), []
    with zipfile.ZipFile(archive) as z:
        seen = set()
        for entry in z.infolist():
            name = safe_name(entry.filename)
            if name in seen:
                raise ValueError('ZIP重复路径')
            seen.add(name)
            mode = entry.external_attr >> 16
            if entry.is_dir():
                directories.add(name)
                continue
            parts = name.split('/')
            directories.update('/'.join(parts[:i]) for i in range(1, len(parts)))
            if stat.S_ISLNK(mode):
                target = z.read(entry).decode('utf-8')
                if not target or target.startswith('/') or '\\' in target:
                    raise ValueError('ZIP链接目标不规范')
                resolved = os.path.normpath(os.path.join(os.path.dirname(name), target))
                if resolved == '..' or resolved.startswith('../'):
                    raise ValueError('ZIP链接逃出dist')
                files[name] = {'kind': 'link', 'target': target}
            elif stat.S_IFMT(mode) not in (0, stat.S_IFREG):
                raise ValueError('ZIP含非文件类型')
            else:
                with z.open(entry) as stream:
                    files[name] = {'kind': 'file', 'sha256': digest(stream), 'bytes': entry.file_size}
        # 官方installer仅把类型声明移到npm package根，其余完整dist原位。
        actual_files, actual_dirs = set(), set()
        for current, dirs, names in os.walk(dist, followlinks=False):
            for name in list(dirs):
                item = pathlib.Path(current) / name
                relative = item.relative_to(dist).as_posix()
                if item.is_symlink():
                    actual_files.add(relative)
                    dirs.remove(name)
                else:
                    actual_dirs.add(relative)
            actual_files.update((pathlib.Path(current) / name).relative_to(dist).as_posix() for name in names)
        expected_dist = set(files) - {'electron.d.ts'}
        if actual_files != expected_dist or actual_dirs != directories:
            raise ValueError('实际Electron完整dist集合缺项或多项')
        for name, expected in sorted(files.items()):
            item = package / name if name == 'electron.d.ts' else dist / name
            info = item.lstat()
            if expected['kind'] == 'link':
                if not stat.S_ISLNK(info.st_mode) or os.readlink(item) != expected['target']:
                    raise ValueError('实际Electron链接改变：' + name)
                resolved = item.resolve(strict=True)
                if not resolved.is_relative_to(dist):
                    raise ValueError('实际Electron链接逃出dist')
            else:
                if not stat.S_ISREG(info.st_mode) or item.is_symlink() or info.st_size != expected['bytes']:
                    raise ValueError('实际Electron文件类型/大小改变：' + name)
                with item.open('rb') as stream:
                    if digest(stream) != expected['sha256']:
                        raise ValueError('实际Electron文件字节改变：' + name)
            identities.append({'path': name, **expected})
    exe = dist / safe_name(executable)
    if files.get(executable, {}).get('kind') != 'file' or not os.access(exe, os.X_OK):
        raise ValueError('官方执行文件缺失或不可执行')
    aggregate = hashlib.sha256(json.dumps(identities, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
    return {'treeSha256': aggregate, 'archiveEntries': len(seen), 'fileEntries': len(files),
            'executablePath': str(exe), 'executableSha256': files[executable]['sha256']}


if __name__ == '__main__':
    try:
        print(json.dumps(verify_tree(*sys.argv[1:]), ensure_ascii=False))
    except Exception as error:
        print('Electron官方树核验失败：' + str(error), file=sys.stderr)
        sys.exit(1)
