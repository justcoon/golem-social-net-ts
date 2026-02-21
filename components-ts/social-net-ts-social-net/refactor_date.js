const fs = require('fs');
const path = require('path');

function walk(dir) {
    let results = [];
    const list = fs.readdirSync(dir);
    list.forEach(function (file) {
        file = path.join(dir, file);
        const stat = fs.statSync(file);
        if (stat && stat.isDirectory()) {
            results = results.concat(walk(file));
        } else {
            if (file.endsWith('.ts')) results.push(file);
        }
    });
    return results;
}

const files = walk('./src');
for (const file of files) {
    let code = fs.readFileSync(file, 'utf8');

    // Type definitions
    code = code.replace(/: Date;/g, ': number;');
    code = code.replace(/Date \| null/g, 'number | null');
    code = code.replace(/Date \| undefined/g, 'number | undefined');
    code = code.replace(/: Date\)/g, ': number)');
    code = code.replace(/: Date,/g, ': number,');

    // Date instantiations
    code = code.replace(/new Date\(\)/g, 'Date.now()');

    // getTime() removals
    code = code.replace(/\.getTime\(\)/g, '');

    // Rehydrations new Date(xyz) -> xyz
    code = code.replace(/new Date\(([a-zA-Z0-9_.[\]]+)\)/g, '$1');

    // toISOString() -> toString()
    code = code.replace(/\.toISOString\(\)/g, '.toString()');

    fs.writeFileSync(file, code, 'utf8');
}
console.log('Date refactoring complete.');
