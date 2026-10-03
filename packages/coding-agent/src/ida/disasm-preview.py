"""Disassembly preview of one file for the artifact browser, via idalib.

usage: python disasm-preview.py PATH MAX_LINES

Prints one JSON object on stdout: {"arch", "start", "lines"} when the file is an executable IDA
loads (disassembly from its entry point) or a raw blob that decodes as plausible code for a
supported architecture; {"none": reason} otherwise. The file is analysed from a copy in a temp
directory, so no database ever lands beside it.
"""

import json
import os
import shutil
import sys
import tempfile

_out = os.fdopen(os.dup(1), "w", encoding="utf-8")
os.dup2(2, 1)

import idapro  # noqa: E402,F401  (loads libidalib before any ida_* module)
import ida_bytes  # noqa: E402
import ida_idaapi  # noqa: E402
import ida_ida  # noqa: E402
import ida_lines  # noqa: E402
import ida_segment  # noqa: E402
import ida_ua  # noqa: E402
from ida_domain import Database  # noqa: E402
from ida_domain.database import IdaCommandOptions  # noqa: E402

# A raw blob is judged on its first SAMPLE bytes: at least MIN_COVERAGE of them must decode, at
# least MIN_COMMON of the instructions must be everyday ones, and at most MAX_RARE privileged or
# legacy oddities (random bytes decode as x86 too, but full of `in`/`out`/`lods`/`aaa`).
SAMPLE = 1024
MIN_COVERAGE = 0.97
MIN_COMMON = 0.55
MAX_RARE = 0.03
COMMON = {
    "x86-64": {
        "mov", "movzx", "movsx", "movsxd", "lea", "push", "pop", "call", "jmp", "ret", "retn", "cmp",
        "test", "add", "sub", "xor", "and", "or", "inc", "dec", "shl", "shr", "sar", "imul", "nop",
        "jz", "jnz", "je", "jne", "jb", "jnb", "jbe", "ja", "jl", "jge", "jle", "jg", "js", "jns",
        "cmovz", "cmovnz", "setz", "setnz", "int3", "movaps", "movups", "movdqa", "movdqu", "movq",
        "movd", "pxor", "xorps", "leave", "endbr64", "cdqe", "cqo", "neg", "not",
    },
    "arm64": {
        "mov", "movz", "movk", "ldr", "str", "ldp", "stp", "ldrb", "strb", "ldrh", "strh", "ldur",
        "stur", "add", "sub", "adds", "subs", "cmp", "cmn", "b", "bl", "br", "blr", "ret", "cbz",
        "cbnz", "tbz", "tbnz", "adrp", "adr", "and", "orr", "eor", "lsl", "lsr", "asr", "csel",
        "cset", "nop", "mul", "madd", "b.eq", "b.ne", "b.lt", "b.ge", "b.gt", "b.le", "b.hi",
        "b.ls", "b.cc", "b.cs", "paciasp", "autiasp", "bti",
    },
}
RARE = {
    "x86-64": {
        "in", "out", "ins", "outs", "insb", "insd", "outsb", "outsd", "lods", "scas", "cli", "sti", "hlt",
        "iret", "iretd", "iretq", "aaa", "aas", "daa", "das", "into", "bound", "arpl", "sahf", "lahf",
        "std", "cmc", "clc", "stc", "wait", "xlat", "loop", "loope", "loopne", "jrcxz", "les", "lds",
        "retf", "rcl", "rcr", "enter", "pushf", "popf", "int", "fwait", "icebp", "int1",
    },
    "arm64": {"udf", "hlt", "hvc", "smc", "svc", "brk", "dcps1", "dcps2", "dcps3"},
}
# Padding the judge ignores (x86 `int3` fill between functions).
PADDING = {"x86-64": {0xCC}, "arm64": set()}
# Raw-blob candidates: (label, IDA processor, segment addressing: 1 = 32-bit, 2 = 64-bit).
RAW = (("x86-64", "metapc", 2), ("arm64", "arm", 2))
EXECUTABLE_MAGIC = (b"\x7fELF", b"MZ", b"\xcf\xfa\xed\xfe", b"\xce\xfa\xed\xfe", b"\xca\xfe\xba\xbe")


def _line(ea):
    # Address and instruction only: the preview sits in a narrow sidebar.
    text = ida_lines.tag_remove(ida_lines.generate_disasm_line(ea, ida_lines.GENDSM_FORCE_CODE) or "")
    return f"{ea:08x}  {' '.join(text.split())}"


def _walk(start, end, limit):
    """Linear decode from start: (lines, decoded bytes, total bytes, [(mnemonic, first byte)])."""
    lines, decoded_bytes, total_bytes, insns = [], 0, 0, []
    ea = start
    while ea < end and len(lines) < limit:
        insn = ida_ua.insn_t()
        size = ida_ua.decode_insn(insn, ea)
        if size <= 0:
            lines.append(f"{ea:08x}  db {(ida_bytes.get_bytes(ea, 1) or b'?').hex()}h")
            total_bytes += 1
            ea += 1
            continue
        decoded_bytes += size
        total_bytes += size
        insns.append((insn.get_canon_mnem().lower(), ida_bytes.get_byte(ea)))
        lines.append(_line(ea))
        ea += size
    return lines, decoded_bytes, total_bytes, insns


def _judge(label, start, end):
    """Score of the sample as code for `label`, or None when it does not read as code."""
    _, decoded, total, insns = _walk(start, min(end, start + SAMPLE), SAMPLE)
    counted = [mnem for mnem, first in insns if first not in PADDING[label]]
    if total == 0 or not counted:
        return None
    coverage = decoded / total
    common = sum(1 for mnem in counted if mnem in COMMON[label]) / len(counted)
    rare = sum(1 for mnem in counted if mnem in RARE[label]) / len(counted)
    if coverage < MIN_COVERAGE or common < MIN_COMMON or rare > MAX_RARE:
        return None
    return coverage + common - rare


def _open(path, processor=None):
    work = tempfile.mkdtemp(prefix="omp-disasm-")
    copy = os.path.join(work, os.path.basename(path))
    shutil.copyfile(path, copy)
    opts = IdaCommandOptions(auto_analysis=False, new_database=True, output_database=copy + ".i64", processor=processor)
    return Database.open(copy, opts, save_on_close=False), work


def _close(db, work):
    try:
        db.close(save=False)
    finally:
        shutil.rmtree(work, ignore_errors=True)


def _executable(path, limit):
    db, work = _open(path)
    try:
        start = db.start_ip
        if start == ida_idaapi.BADADDR:
            start = db.minimum_ea
        lines = _walk(start, db.maximum_ea, limit)[0]
        arch = {"metapc": "x86"}.get(db.architecture, db.architecture)
        return {"arch": f"{arch} {db.bitness}-bit · {db.format}", "start": start, "lines": lines}
    finally:
        _close(db, work)


def _raw(path, limit):
    best = None
    for label, processor, addressing in RAW:
        db, work = _open(path, processor)
        try:
            seg = ida_segment.getseg(db.minimum_ea)
            if seg is None:
                continue
            ida_segment.set_segm_addressing(seg, addressing)
            start, end = seg.start_ea, seg.end_ea
            score = _judge(label, start, end)
            if score is None:
                continue
            if best is None or score > best[0]:
                lines = _walk(start, end, limit)[0]
                best = (score, {"arch": f"{label} (raw)", "start": start, "lines": lines})
        finally:
            _close(db, work)
    return best[1] if best else {"none": "no supported architecture decodes it as code"}


def main():
    path, limit = sys.argv[1], int(sys.argv[2])
    with open(path, "rb") as f:
        head = f.read(4)
    is_executable = any(head.startswith(magic) for magic in EXECUTABLE_MAGIC)
    result = _executable(path, limit) if is_executable else _raw(path, limit)
    _out.write(json.dumps(result))
    _out.flush()


main()
