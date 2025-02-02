/*
 * Copyright 2018 Unbounded Systems, LLC
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

const { onExit } = require("@adpt/utils/dist/src/exit");
const chai = require("chai");
const chaiAsPromised = require("chai-as-promised");

chai.use(chaiAsPromised);

// Capture stderr and its write function before they can get monkey patched
const writeErr = process.stderr.write.bind(process.stderr);

onExit((signal, details) => {
    if (signal === 'unhandledRejection') {
        const err = typeof details === "number" ? details : details.stack;
        writeErr("\n\nExiting on unhandled promise rejection: " + err);
    }
});
