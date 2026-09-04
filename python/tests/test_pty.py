import asyncio

from dolphin_terminal.app import coalesce_pty_output


def test_coalesces_only_already_queued_output_and_preserves_eof():
    queue = asyncio.Queue()
    queue.put_nowait(b"two")
    queue.put_nowait(b"three")
    queue.put_nowait(None)

    assert coalesce_pty_output(queue, b"one") == b"onetwothree"
    assert queue.get_nowait() is None
