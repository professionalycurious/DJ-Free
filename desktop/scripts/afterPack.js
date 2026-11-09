// Sets the Windows .exe icon and version info without needing Wine/rcedit (pure JS via resedit).
const fs = require('fs');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const { load } = require('resedit/cjs');
  const ResEdit = await load();
  const exeName = context.packager.appInfo.productFilename + '.exe';
  const exePath = path.join(context.appOutDir, exeName);
  const version = context.packager.appInfo.version;
  const exe = ResEdit.NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(exe);
  const ico = ResEdit.Data.IconFile.from(fs.readFileSync(path.join(__dirname, '..', 'build', 'icon.ico')));
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  const groupId = groups.length ? groups[0].id : 1;
  const lang = groups.length ? groups[0].lang : 1033;
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, groupId, lang, ico.icons.map((i) => i.data));
  const vis = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
  const vi = vis.length ? vis[0] : ResEdit.Resource.VersionInfo.createEmpty();
  const [ma, mi, pa] = version.split('.').map((n) => parseInt(n, 10) || 0);
  vi.setFileVersion(ma, mi, pa, 0, 1033);
  vi.setProductVersion(ma, mi, pa, 0, 1033);
  const strings = { CompanyName: 'DJ Free', FileDescription: 'DJ Free', ProductName: 'DJ Free', InternalName: 'DJ Free', OriginalFilename: exeName, LegalCopyright: 'DJ Free', FileVersion: version, ProductVersion: version };
  for (const lng of vi.getAllLanguagesForStringValues()) vi.setStringValues(lng, strings);
  if (!vi.getAllLanguagesForStringValues().length) vi.setStringValues({ lang: 1033, codepage: 1200 }, strings);
  vi.outputToResourceEntries(res.entries);
  res.outputResource(exe);
  fs.writeFileSync(exePath, Buffer.from(exe.generate()));
  console.log('  • set icon + version info on', exeName);
};
