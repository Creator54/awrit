#!/usr/bin/env python3
"""Package an already staged, verified payload. No installation or publishing."""
import hashlib
import pathlib
import sys
import tarfile
from verify import verify

root = pathlib.Path(sys.argv[1]).resolve()
destination = pathlib.Path(sys.argv[2]).resolve()
if destination.exists() or pathlib.Path(str(destination) + '.sha256').exists():
    raise SystemExit('Refusing to overwrite an archive or checksum')
verify(root)
with destination.open('xb') as output:
    with tarfile.open(fileobj=output, mode='w:gz', dereference=False) as archive:
        archive.add(root, arcname='awrit')
digest = hashlib.sha256(destination.read_bytes()).hexdigest()
pathlib.Path(str(destination) + '.sha256').write_text(f'{digest}  {destination.name}\n')
print(destination)
