"use strict";

// Partner Center package identity must be supplied verbatim; never guess a publisher.
const base = require("./builder.config.js");

function required(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error("[Microsoft Store] Missing Partner Center value: " + name);
  return value;
}

function storeIdentity(env = process.env) {
  function field(name) {
    const value = String(env[name] || "").trim();
    if (!value) throw new Error("[Microsoft Store] Missing Partner Center value: " + name);
    return value;
  }
  const identityName = field("NOWEN_STORE_IDENTITY_NAME");
  const publisher = field("NOWEN_STORE_PUBLISHER");
  const publisherDisplayName = field("NOWEN_STORE_PUBLISHER_DISPLAY_NAME");
  const applicationId = String(env.NOWEN_STORE_APPLICATION_ID || "NowenNote").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]{2,99}$/.test(identityName) || identityName.includes("..")) {
    throw new Error("[Microsoft Store] Invalid NOWEN_STORE_IDENTITY_NAME");
  }
  if (!/^CN=[^\r\n]+$/.test(publisher) || /^(CN=(?:ms|test|placeholder))$/i.test(publisher)) {
    throw new Error("[Microsoft Store] Invalid NOWEN_STORE_PUBLISHER; copy exact Package/Identity/Publisher from Partner Center");
  }
  if (publisherDisplayName.length > 128 || /[\r\n]/.test(publisherDisplayName)) {
    throw new Error("[Microsoft Store] Invalid NOWEN_STORE_PUBLISHER_DISPLAY_NAME");
  }
  if (!/^[A-Za-z][A-Za-z0-9.]{0,63}$/.test(applicationId) || applicationId.includes("..")) {
    throw new Error("[Microsoft Store] Invalid NOWEN_STORE_APPLICATION_ID");
  }
  return { identityName, publisher, publisherDisplayName, applicationId };
}

function createStoreConfig(identity) {
  return {
    ...base,
    directories: { ...base.directories, output: "dist-electron-store" },
    // Store artifacts must never enter the existing NSIS/SignPath/GitHub release stream.
    publish: null,
    win: {
      ...base.win,
      target: [{ target: "appx", arch: ["x64"] }],
      artifactName: "Nowen-Note-Store-\x24{version}-\x24{arch}.\x24{ext}",
    },
    appx: {
      ...identity,
      displayName: "Nowen Note",
      languages: ["zh-CN", "en-US"],
      capabilities: ["runFullTrust", "internetClient", "privateNetworkClientServer"],
      minVersion: "10.0.19041.0",
    },
  };
}

// A Store submission cannot be accidentally built with guessed Microsoft identity values.
module.exports = createStoreConfig(storeIdentity());
module.exports.storeIdentity = storeIdentity;
module.exports.createStoreConfig = createStoreConfig;
