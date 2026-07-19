'use client';

// Shared icon picker cell: a compact square button that opens a modal to set an emoji OR upload an
// image. An emoji and an uploaded image can be held at once — on save the uploaded image wins, else the
// emoji, else the icon is cleared. Upload accepts click or drag-and-drop. Used by the shipment-code
// Logo cell and the Export-courier icon cell; the generic Settings list rows keep their own inline copy
// because they save through the row draft.

import { useState } from 'react';
import type { ChangeEvent, DragEvent } from 'react';
import { uploadSettingIcon } from '@/app/settings/actions';
import { useOverlayClose } from '@/components/useOverlayClose';

// a stored value is an uploaded image when it's a URL/path; otherwise it's a short emoji/text.
const isIconUrl = (s: string | null | undefined): boolean => !!s && /^(https?:\/\/|\/)/.test(s);

export default function IconCell({
  value,
  onChange,
  disabled = false,
  title = 'Icon',
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  disabled?: boolean;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  // the saved value splits into two draft slots — a typed emoji and an uploaded image URL.
  const initEmoji = value && !isIconUrl(value) ? value : '';
  const initImage = value && isIconUrl(value) ? value : null;
  const [emoji, setEmoji] = useState(initEmoji);
  const [imageUrl, setImageUrl] = useState<string | null>(initImage);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  // PR307 — closing with a typed-but-unsaved emoji/image routes through the discard confirm.
  const close = useOverlayClose({ open, onClose: () => setOpen(false), dirty: emoji !== initEmoji || imageUrl !== initImage });

  async function uploadFile(file: File) {
    if (!file.type.startsWith('image/')) return; // ignore non-image drops
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const { url } = await uploadSettingIcon(fd);
      setImageUrl(url); // stage it; not committed until Save changes
    } catch { /* surfaced elsewhere */ } finally { setUploading(false); }
  }
  async function pick(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) await uploadFile(file);
  }
  function onDrop(e: DragEvent<HTMLLabelElement>) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void uploadFile(file);
  }
  function save() { onChange(imageUrl || emoji.trim() || null); setOpen(false); }
  function remove() { setEmoji(''); setImageUrl(null); onChange(null); setOpen(false); }

  return (
    <div className="set-ico-wrap">
      <button type="button" className="set-ico" onClick={() => setOpen(true)} disabled={disabled} aria-label={`Set ${title.toLowerCase()}`}>
        {value ? (
          isIconUrl(value)
            // eslint-disable-next-line @next/next/no-img-element -- static Storage CDN icon, off the data path
            ? <img className="set-ico-img" src={value} alt="" />
            : <span className="set-ico-emoji">{value}</span>
        ) : <span className="set-ico-add">+</span>}
      </button>
      {open && (
        <div className="sc-modal-backdrop" onClick={close.requestClose}>
          <div className="sc-modal sc-modal-sm" role="dialog" aria-modal="true" aria-label={`Set ${title.toLowerCase()}`} onClick={(e) => e.stopPropagation()}>
            <div className="sc-modal-head sc-modal-head-row"><span className="sc-modal-title">{title}</span><button className="sc-modal-x" onClick={close.requestClose} aria-label="Close">×</button></div>
            <div className="sc-modal-body">
              {/* Uploaded image — a drop/click zone when empty; once staged, a square centered preview with a red × to clear it. */}
              <div className="po-field">
                <label>Uploaded image</label>
                {imageUrl ? (
                  <div className="set-ico-uploaded">
                    {/* eslint-disable-next-line @next/next/no-img-element -- static Storage CDN icon, off the data path */}
                    <img className="set-ico-uploaded-img" src={imageUrl} alt="" />
                    <button className="set-ico-clear" onClick={() => setImageUrl(null)} disabled={uploading} aria-label="Remove uploaded image">✕</button>
                  </div>
                ) : (
                  <label
                    className={`set-ico-drop${dragOver ? ' over' : ''}${uploading ? ' disabled' : ''}`}
                    onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                    onDragLeave={(e) => { e.preventDefault(); setDragOver(false); }}
                    onDrop={onDrop}
                  >
                    {uploading ? 'Uploading…' : 'Drop an image here or click to upload'}
                    <input type="file" accept="image/*" hidden onChange={pick} disabled={uploading} />
                  </label>
                )}
              </div>
              <div className="po-field">
                <label>Emoji</label>
                <input type="text" value={emoji} maxLength={8} placeholder="Insert an emoji here" onChange={(e) => setEmoji(e.target.value)} />
              </div>
              {imageUrl && emoji.trim() && <p className="hint set-ico-note">The uploaded image will be used.</p>}
              <div className="confirm-actions" style={{ marginTop: 4 }}>
                <button className="btn-primary" onClick={save} disabled={uploading}>Save changes</button>
                <button className="btn-danger" onClick={remove} disabled={uploading}>Remove icon</button>
              </div>
            </div>
          </div>
          {close.confirm}
        </div>
      )}
    </div>
  );
}
