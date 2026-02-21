const fs = require('fs');

const rustYaml = fs.readFileSync('/Users/coon/workspace-zv/git/golem-social-net-rust/components-rust/social-net-rust-social-net/golem.yaml', 'utf8');
const tsYaml = fs.readFileSync('/Users/coon/workspace-zv/git/golem-social-net-ts/components-ts/social-net-ts-social-net/golem.yaml', 'utf8');

const rustApiPart = rustYaml.split(/^components:/m)[0];

const newApiPart = rustApiPart.replace(/social-net-rust:social-net/g, 'social-net-ts:social-net')
    .replace(/golem-social-net-rust/g, 'golem-social-net-ts');

const tsComponentsPart = tsYaml.substring(tsYaml.search(/^components:/m));

const newTsYaml = newApiPart + tsComponentsPart;

fs.writeFileSync('/Users/coon/workspace-zv/git/golem-social-net-ts/components-ts/social-net-ts-social-net/golem.yaml', newTsYaml);
console.log('Merged API configurations from Rust into TS');
