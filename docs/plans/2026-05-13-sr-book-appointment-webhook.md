# Book Appointment Webhook Button

**Date:** 2026-05-13  
**Owner:** sr

## Problem
After a SOAP note completes, there is no way to trigger downstream appointment booking directly from the app. The booking system is an n8n workflow that accepts a webhook POST.

## Goal
Add a "Book Appointment" button next to the existing "Open" button in the notes status window. Clicking it POSTs the completed SOAP note and session metadata to the n8n webhook.

---

## Webhook contract

**URL:** `https://pa.n8n.ndproject.dev/webhook/book-appointment`  
**Method:** POST  
**Content-Type:** application/json

**Body:**
```json
{
  "details": {
    "doctor_name": "<active session doctor name>",
    "doctor_email": "rishabh@navadhiti.com",
    "patient_name": "<name entered at recording/upload>",
    "patient_number": "<alternates xxxxxxxxxx / yyyyyyyyyy per request>"
  },
  "generated_note": "<raw markdown content of the soap note .md file>"
}
```

`patient_number` alternates on every call (tracked by a module-level `appointmentCounter` in main.js).

---

## Files to change

| File | Change |
|---|---|
| `main.js` | Add `appointmentCounter`, `postBookingWebhook()` helper, `book-appointment` IPC handler |
| `preload.js` | Expose `bookAppointment(soapDocxPath)` |
| `renderer/status.js` | Add "Book Appointment" button in both single-patient and multi-patient completed-note branches |
| `renderer/status.css` | Add `.book-btn` style (blue accent, mirrors `.open-btn` pattern) |

---

## Implementation details

### main.js additions

```js
// module-level
let appointmentCounter = 0

// helper (near validateElevenLabsKey)
function postBookingWebhook(payload) {
  return new Promise(resolve => {
    const body = JSON.stringify(payload)
    const req = https.request(
      {
        hostname: 'pa.n8n.ndproject.dev',
        path: '/webhook/book-appointment',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      },
      res => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode })
    )
    req.on('error', err => resolve({ ok: false, error: err.message }))
    req.write(body)
    req.end()
  })
}

// IPC handler (after open-soap-note handler)
ipcMain.handle('book-appointment', async (_, soapDocxPath) => {
  const PATIENT_NUMBERS = ['xxxxxxxxxx', 'yyyyyyyyyy']
  const patientNumber = PATIENT_NUMBERS[appointmentCounter % 2]
  appointmentCounter++

  const settings = readSettings()
  const doctor = (settings.doctors || []).find(d => d.id === activeDoctorId)
  const doctorName = doctor?.name || 'Unknown Doctor'

  let patientName = 'Unknown Patient'
  for (const rec of sessionRecordings) {
    if (rec.soapDocxPath === soapDocxPath) { patientName = rec.displayName; break }
    const p = rec.patients?.find(p => p.soapDocxPath === soapDocxPath)
    if (p) { patientName = p.name; break }
  }

  const soapMdPath = soapDocxPath.replace(/\.docx$/, '.md')
  let noteContent = ''
  try { noteContent = fs.readFileSync(soapMdPath, 'utf8') }
  catch (e) { log(`[book-appointment] Could not read soap note: ${e.message}`) }

  const payload = {
    details: { doctor_name: doctorName, doctor_email: 'rishabh@navadhiti.com', patient_name: patientName, patient_number: patientNumber },
    generated_note: noteContent
  }
  log(`[book-appointment] Sending for patient "${patientName}" (doctor: "${doctorName}")`)
  return postBookingWebhook(payload)
})
```

### preload.js addition
```js
bookAppointment: (soapDocxPath) => ipcRenderer.invoke('book-appointment', soapDocxPath),
```

### renderer/status.js button (same pattern for both branches)
```js
const bookBtn = document.createElement('button')
bookBtn.className = 'book-btn'
bookBtn.textContent = 'Book Appointment'
bookBtn.addEventListener('click', async () => {
  bookBtn.disabled = true
  bookBtn.textContent = 'Booking...'
  const result = await api.bookAppointment(/* soapDocxPath */)
  bookBtn.textContent = result?.ok ? 'Booked' : 'Book Appointment'
  if (!result?.ok) bookBtn.disabled = false
})
statusRow.appendChild(bookBtn)
```

### renderer/status.css
```css
.book-btn {
  padding: 1px 7px;
  background: transparent;
  border: 1px solid #4a9edd;
  color: #4a9edd;
  font-size: 10px;
  border-radius: 3px;
  cursor: pointer;
  flex-shrink: 0;
}
.book-btn:hover  { background: #4a9edd; color: #fff; }
.book-btn:disabled { opacity: 0.5; cursor: default; }
```

---

## Verification
1. `npm start` — start a session, record or upload a file
2. Wait for SOAP note to complete — status window shows "Completed" + "Open" button
3. "Book Appointment" button appears next to "Open" (blue border)
4. Click it — shows "Booking..." then "Booked"
5. Confirm in n8n the webhook fired with correct doctor/patient name and soap note content
6. Click on a second completed note — `patient_number` alternates to the other value
