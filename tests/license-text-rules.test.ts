/*
 * Copyright 2026 Zaphiro Technologies
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { describe, expect, it } from "vitest";
import { identifyLicenseText } from "../src/dependencies/sources/metadata.js";
import { licenseFromPythonClassifier } from "../src/dependencies/python/parsers/classifiers.js";

describe("license text rules", () => {
  it("uses configured rules before built-in fingerprints", () => {
    expect(
      identifyLicenseText(
        "Permission is hereby granted, free of charge, to any person.",
        [
          {
            source: "license-text",
            match: "permission is hereby granted",
            license: "LicenseRef-Custom",
          },
        ],
      ),
    ).toBe("LicenseRef-Custom");
  });

  it("retains built-in license fingerprints when no custom rule matches", () => {
    expect(
      identifyLicenseText(
        "Permission is hereby granted, free of charge, to any person.",
        [
          {
            source: "license-text",
            match: "unrelated fingerprint",
            license: "LicenseRef-Custom",
          },
        ],
      ),
    ).toBe("MIT");
  });
});

describe("Python classifier rules", () => {
  it("lets configured patterns override built-in classifier mappings", () => {
    expect(
      licenseFromPythonClassifier(
        "License :: Other/Proprietary License (Acme)",
        [
          {
            source: "python-classifier",
            match: "proprietary license",
            license: "LicenseRef-Acme",
          },
        ],
      ),
    ).toBe("LicenseRef-Acme");
  });
});
