package main

// The wire protocol between the app and the relay. It is deliberately small:
// one duplex byte stream (stdin/stdout over ssh or pkexec), length-prefixed
// frames, JSON for control and raw bytes for file payloads. See docs/design.md,
// "One protocol, three transports".

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"sync"
)

const (
	frameRequest  byte = 0
	frameResponse byte = 1
	frameBlob     byte = 2
	frameEvent    byte = 3

	// The largest payload either side will allocate. A frame that claims more
	// is refused before the allocation, so a corrupt or hostile length cannot
	// exhaust memory.
	maxFrame = 64 * 1024 * 1024
)

// Request is one operation. The fields are shared across operations; a request
// fills only the ones its Op reads. Blob carries the raw payload of an
// operation that sends bytes after its JSON frame (write, readImage is the
// reverse direction).
type Request struct {
	Op          string   `json:"op"`
	Path        string   `json:"path,omitempty"`
	Target      string   `json:"target,omitempty"`
	Source      string   `json:"source,omitempty"`
	Dir         string   `json:"dir,omitempty"`
	Name        string   `json:"name,omitempty"`
	Sources     []string `json:"sources,omitempty"`
	Destination string   `json:"destination,omitempty"`
	BaseDir     string   `json:"baseDir,omitempty"`
	Targets     []string `json:"targets,omitempty"`
	Cols        int      `json:"cols,omitempty"`
	Rows        int      `json:"rows,omitempty"`
	ID          string   `json:"id,omitempty"`
	Data        string   `json:"data,omitempty"`
	Shell       string   `json:"shell,omitempty"`

	// Filled by the reader for operations whose payload follows as a BLOB
	// frame. Never encoded in the JSON frame itself.
	Blob []byte `json:"-"`
}

// Response is one answer. A failed operation carries an error and no data.
type Response struct {
	Ok    bool     `json:"ok"`
	Data  any      `json:"data,omitempty"`
	Error *FsError `json:"error,omitempty"`
}

// FsError mirrors the app's Result<T> error shape so a pane's notice reads the
// same whether the answer came from main or from a relay.
type FsError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *FsError) Error() string { return e.Code + ": " + e.Message }

// Event is an unsolicited message: pty output, a watch notification, a pty
// exit. Its ID is the pty or watch id when it belongs to one, otherwise empty.
type Event struct {
	Type     string `json:"type"`
	Path     string `json:"path,omitempty"`
	ID       string `json:"id,omitempty"`
	Data     string `json:"data,omitempty"`
	ExitCode *int   `json:"exitCode,omitempty"`
	Signal   *int   `json:"signal,omitempty"`
}

// Conn frames one duplex stream. Reads happen on one goroutine; writes may come
// from handlers and pty readers at once, so the write lock is held across the
// header and the payload to keep one frame from interleaving with another.
type Conn struct {
	r  io.Reader
	w  io.Writer
	mu sync.Mutex
}

func NewConn(r io.Reader, w io.Writer) *Conn {
	return &Conn{r: r, w: w}
}

// ReadFrame returns the frame's type, id and payload. The payload is allocated
// only after the declared length has been checked, so a hostile frame cannot
// ask for an allocation it did not have to earn.
func (c *Conn) ReadFrame() (byte, uint32, []byte, error) {
	var header [9]byte
	if _, err := io.ReadFull(c.r, header[:]); err != nil {
		return 0, 0, nil, err
	}
	length := binary.BigEndian.Uint32(header[0:4])
	if length > maxFrame {
		return 0, 0, nil, fmt.Errorf("frame too large: %d", length)
	}
	kind := header[4]
	id := binary.BigEndian.Uint32(header[5:9])
	payload := make([]byte, length)
	if _, err := io.ReadFull(c.r, payload); err != nil {
		return 0, 0, nil, err
	}
	return kind, id, payload, nil
}

// WriteFrame writes one frame under the lock. The lock covers both the header
// and the payload so two writers cannot interleave a frame's halves.
func (c *Conn) WriteFrame(kind byte, id uint32, payload []byte) error {
	if len(payload) > maxFrame {
		return fmt.Errorf("frame too large: %d", len(payload))
	}
	c.mu.Lock()
	defer c.mu.Unlock()

	var header [9]byte
	binary.BigEndian.PutUint32(header[0:4], uint32(len(payload)))
	header[4] = kind
	binary.BigEndian.PutUint32(header[5:9], id)
	if _, err := c.w.Write(header[:]); err != nil {
		return err
	}
	_, err := c.w.Write(payload)
	return err
}

// WriteJSON encodes v and writes it as a frame of the given type.
func (c *Conn) WriteJSON(kind byte, id uint32, v any) error {
	payload, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return c.WriteFrame(kind, id, payload)
}

// WriteBlob writes raw bytes as a BLOB frame belonging to a request id.
func (c *Conn) WriteBlob(id uint32, blob []byte) error {
	return c.WriteFrame(frameBlob, id, blob)
}

// SendResponse writes a successful or failed answer.
func (c *Conn) SendResponse(id uint32, response Response) error {
	return c.WriteJSON(frameResponse, id, response)
}

// SendResponseWithBlob writes a response and the BLOB that belongs to it as one
// locked pair, so an event from another goroutine cannot land between the
// metadata and the bytes the client is waiting to assemble.
func (c *Conn) SendResponseWithBlob(id uint32, response Response, blob []byte) error {
	payload, err := json.Marshal(response)
	if err != nil {
		return err
	}
	if len(payload) > maxFrame || len(blob) > maxFrame {
		return fmt.Errorf("frame too large")
	}
	c.mu.Lock()
	defer c.mu.Unlock()

	var header [9]byte
	binary.BigEndian.PutUint32(header[0:4], uint32(len(payload)))
	header[4] = frameResponse
	binary.BigEndian.PutUint32(header[5:9], id)
	if _, err := c.w.Write(header[:]); err != nil {
		return err
	}
	if _, err := c.w.Write(payload); err != nil {
		return err
	}

	binary.BigEndian.PutUint32(header[0:4], uint32(len(blob)))
	header[4] = frameBlob
	if _, err := c.w.Write(header[:]); err != nil {
		return err
	}
	_, err = c.w.Write(blob)
	return err
}

// SendEvent writes an unsolicited event.
func (c *Conn) SendEvent(event Event) error {
	return c.WriteJSON(frameEvent, 0, event)
}
