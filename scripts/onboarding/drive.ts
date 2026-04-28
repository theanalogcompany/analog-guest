import { google, type drive_v3 } from 'googleapis'

export interface DriveFileMeta {
  id: string
  name: string
  mimeType: string
}

const FOLDER_MIME = 'application/vnd.google-apps.folder'
const GDOC_MIME = 'application/vnd.google-apps.document'
const GSHEET_MIME = 'application/vnd.google-apps.spreadsheet'

/**
 * Returns a Drive client authed via Application Default Credentials.
 * Pre-flight: `gcloud auth application-default login` must have been run.
 */
export function getDrive(): drive_v3.Drive {
  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/drive'],
  })
  return google.drive({ version: 'v3', auth })
}

export async function findVenueFolder(
  drive: drive_v3.Drive,
  parentFolderId: string,
  slug: string,
): Promise<DriveFileMeta> {
  const q = [
    `'${parentFolderId}' in parents`,
    `name = '${slug.replace(/'/g, "\\'")}'`,
    `mimeType = '${FOLDER_MIME}'`,
    `trashed = false`,
  ].join(' and ')
  const res = await drive.files.list({
    q,
    fields: 'files(id, name, mimeType)',
    pageSize: 5,
  })
  const files = res.data.files ?? []
  if (files.length === 0) {
    throw new Error(`drive: venue folder not found for slug="${slug}" under parent ${parentFolderId}`)
  }
  if (files.length > 1) {
    throw new Error(`drive: multiple folders match slug="${slug}" — ambiguous`)
  }
  const f = files[0]
  if (!f.id || !f.name || !f.mimeType) {
    throw new Error(`drive: venue folder lookup returned malformed metadata`)
  }
  return { id: f.id, name: f.name, mimeType: f.mimeType }
}

export async function listVenueFiles(
  drive: drive_v3.Drive,
  folderId: string,
): Promise<DriveFileMeta[]> {
  const res = await drive.files.list({
    q: `'${folderId}' in parents and trashed = false`,
    fields: 'files(id, name, mimeType)',
    pageSize: 100,
  })
  return (res.data.files ?? []).flatMap((f) => {
    if (!f.id || !f.name || !f.mimeType) return []
    return [{ id: f.id, name: f.name, mimeType: f.mimeType }]
  })
}

/**
 * Read a Drive file as plain text. Google Docs are exported to text/plain;
 * Google Sheets are exported to text/csv; everything else is fetched raw via
 * alt=media (markdown, txt, csv, etc.).
 */
export async function readDriveFileAsText(
  drive: drive_v3.Drive,
  file: DriveFileMeta,
): Promise<string> {
  if (file.mimeType === GDOC_MIME) {
    const res = await drive.files.export(
      { fileId: file.id, mimeType: 'text/plain' },
      { responseType: 'text' },
    )
    return typeof res.data === 'string' ? res.data : String(res.data)
  }
  if (file.mimeType === GSHEET_MIME) {
    const res = await drive.files.export(
      { fileId: file.id, mimeType: 'text/csv' },
      { responseType: 'text' },
    )
    return typeof res.data === 'string' ? res.data : String(res.data)
  }
  // Raw fetch for markdown, plain text, CSV files that aren't Google-native.
  const res = await drive.files.get(
    { fileId: file.id, alt: 'media' },
    { responseType: 'text' },
  )
  return typeof res.data === 'string' ? res.data : String(res.data)
}

/**
 * Upsert a markdown file into a folder by name. If a file with that name
 * already exists, its content is replaced (same fileId preserved); else a
 * new file is created.
 */
export async function writeMarkdownFile(
  drive: drive_v3.Drive,
  folderId: string,
  name: string,
  content: string,
): Promise<{ id: string; created: boolean }> {
  const existing = await drive.files.list({
    q: `'${folderId}' in parents and name = '${name.replace(/'/g, "\\'")}' and trashed = false`,
    fields: 'files(id, name)',
    pageSize: 5,
  })
  const matches = existing.data.files ?? []
  if (matches.length > 1) {
    throw new Error(`drive: multiple files match name="${name}" in folder — ambiguous`)
  }
  if (matches.length === 1 && matches[0].id) {
    await drive.files.update({
      fileId: matches[0].id,
      media: { mimeType: 'text/markdown', body: content },
    })
    return { id: matches[0].id, created: false }
  }
  const res = await drive.files.create({
    requestBody: { name, parents: [folderId], mimeType: 'text/markdown' },
    media: { mimeType: 'text/markdown', body: content },
    fields: 'id',
  })
  if (!res.data.id) throw new Error(`drive: file create returned no id`)
  return { id: res.data.id, created: true }
}

/**
 * Upsert a JSON file into a folder by name. Same idempotency contract as
 * writeMarkdownFile: matching name → update in place; no match → create.
 * Content is serialized with JSON.stringify(_, null, 2).
 */
export async function writeJsonFile(
  drive: drive_v3.Drive,
  folderId: string,
  name: string,
  content: unknown,
): Promise<{ id: string; created: boolean }> {
  const body = JSON.stringify(content, null, 2)
  const existing = await drive.files.list({
    q: `'${folderId}' in parents and name = '${name.replace(/'/g, "\\'")}' and trashed = false`,
    fields: 'files(id, name)',
    pageSize: 5,
  })
  const matches = existing.data.files ?? []
  if (matches.length > 1) {
    throw new Error(`drive: multiple files match name="${name}" in folder — ambiguous`)
  }
  if (matches.length === 1 && matches[0].id) {
    await drive.files.update({
      fileId: matches[0].id,
      media: { mimeType: 'application/json', body },
    })
    return { id: matches[0].id, created: false }
  }
  const res = await drive.files.create({
    requestBody: { name, parents: [folderId], mimeType: 'application/json' },
    media: { mimeType: 'application/json', body },
    fields: 'id',
  })
  if (!res.data.id) throw new Error(`drive: file create returned no id`)
  return { id: res.data.id, created: true }
}

/**
 * Pick the single file in `files` whose name starts with the given numeric
 * prefix (e.g. '04-'). Useful for the deterministic 0N-{slug}- naming scheme.
 */
export function findByPrefix(
  files: DriveFileMeta[],
  prefix: string,
): DriveFileMeta | null {
  const matches = files.filter((f) => f.name.startsWith(prefix))
  if (matches.length === 0) return null
  if (matches.length > 1) {
    throw new Error(
      `drive: multiple files match prefix "${prefix}" (${matches.map((f) => f.name).join(', ')})`,
    )
  }
  return matches[0]
}