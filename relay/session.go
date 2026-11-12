package main

// The sessions a persistent relay keeps alive across connections. A pty's
// output is held in a bounded ring so a client that reconnects can be handed
// exactly the bytes it missed: it remembers one absolute offset and asks for
// what follows. The raft of state sits under `ptyMu` (pty.go), one lock per
// session under `PtySession.mu`.
//
// Offsets are absolute counts of bytes ever written, not indices into the ring,
// so a client never has to know how much the ring has dropped — it asks for
// from <offset> and the server says whether that was still available.

type ringBuffer struct {
	buf  []byte
	base int64 // absolute offset of buf[0]
	next int64 // absolute offset just past the last byte
	max  int
}

func newRingBuffer(max int) ringBuffer {
	return ringBuffer{max: max}
}

// write appends and returns the new next offset. Old bytes are dropped from the
// front once the ring is full, which is what bounds a session's memory.
func (r *ringBuffer) write(p []byte) int64 {
	r.buf = append(r.buf, p...)
	r.next += int64(len(p))
	if len(r.buf) > r.max {
		drop := len(r.buf) - r.max
		r.buf = r.buf[drop:]
		r.base += int64(drop)
	}
	return r.next
}

// since returns the bytes at or after offset, the offset they actually begin at,
// and whether anything before that had already been dropped by the ring. A
// client that is behind the ring gets what survives and is told the gap is
// there, rather than being handed bytes that silently start in the middle of a
// line.
func (r *ringBuffer) since(offset int64) (data []byte, from int64, lost bool) {
	if offset < r.base {
		return append([]byte(nil), r.buf...), r.base, true
	}
	if offset >= r.next {
		return nil, r.next, false
	}
	return append([]byte(nil), r.buf[offset-r.base:]...), offset, false
}
