/**
 * Timetable Scheduler Unified Application Script
 * Combines Solver, Excel Handler, and UI State Controller.
 */

// =========================================================================
// PART 1: CORE SOLVER ENGINE (Simulated Annealing CSP Solver)
// =========================================================================

class TimetableSolver {
    constructor(config) {
        this.config = config;
        this.startDate = new Date(config.startDate);
        this.endDate = new Date(config.endDate);
        this.defaultDailyHours = config.defaultDailyHours || 8;
        
        this.dates = [];
        let cur = new Date(this.startDate);
        while (cur <= this.endDate) {
            this.dates.push(cur.toISOString().split('T')[0]);
            cur.setDate(cur.getDate() + 1);
        }
        this.numDays = this.dates.length;

        this.resources = config.resources || [];
        this.departments = config.departments || [];
        this.mappings = config.mappings || [];

        this.resourceMap = {};
        this.resources.forEach((r, idx) => {
            this.resourceMap[r.name] = idx;
        });

        this.deptMap = {};
        this.departments.forEach((d, idx) => {
            this.deptMap[d.name] = idx;
        });

        this.feasibility = Array(this.resources.length).fill(null).map(() => Array(this.departments.length).fill(false));
        this.minDays = Array(this.resources.length).fill(null).map(() => Array(this.departments.length).fill(0));
        this.maxDays = Array(this.resources.length).fill(null).map(() => Array(this.departments.length).fill(999));

        this.mappings.forEach(m => {
            const rIdx = this.resourceMap[m.resourceName];
            const dIdx = this.deptMap[m.departmentName];
            if (rIdx !== undefined && dIdx !== undefined) {
                this.feasibility[rIdx][dIdx] = m.feasible === true || m.feasible === 'Yes' || m.feasible === 1;
                if (m.minDays !== undefined && m.minDays !== '') this.minDays[rIdx][dIdx] = Number(m.minDays);
                if (m.maxDays !== undefined && m.maxDays !== '') this.maxDays[rIdx][dIdx] = Number(m.maxDays);
            }
        });

        this.absentSets = this.resources.map(r => {
            return new Set(r.absentDates || []);
        });
    }

    solve(numAlternatives = 3) {
        if (this.numDays === 0 || this.resources.length === 0 || this.departments.length === 0) {
            return { status: "error", message: "Missing required config data (dates, resources, or departments)" };
        }

        const schedules = [];
        const seenSignatures = new Set();
        let attempts = 0;
        const maxAttempts = numAlternatives * 5;

        while (schedules.length < numAlternatives && attempts < maxAttempts) {
            attempts++;
            const result = this.runSimulatedAnnealing();
            const signature = this.getScheduleSignature(result.assignments);
            
            if (!seenSignatures.has(signature)) {
                seenSignatures.add(signature);
                schedules.push(result);
            }
        }

        schedules.sort((a, b) => a.cost - b.cost);

        const bestCost = schedules.length > 0 ? schedules[0].cost : 999999;
        const status = bestCost === 0 ? "feasible" : "violations_detected";

        return {
            status,
            schedules
        };
    }

    getScheduleSignature(assignments) {
        return assignments.map(row => row.join(',')).join('|');
    }

    runSimulatedAnnealing() {
        const numResources = this.resources.length;
        const numDepts = this.departments.length;
        const numDays = this.numDays;

        let state = Array(numResources).fill(null).map(() => Array(numDays).fill(-1));

        for (let r = 0; r < numResources; r++) {
            const feasibleDepts = [];
            for (let d = 0; d < numDepts; d++) {
                if (this.feasibility[r][d]) feasibleDepts.push(d);
            }
            if (feasibleDepts.length === 0) continue;

            for (let day = 0; day < numDays; day++) {
                const dateStr = this.dates[day];
                if (this.absentSets[r].has(dateStr)) {
                    state[r][day] = -1;
                } else if (Math.random() < 0.6) {
                    state[r][day] = feasibleDepts[Math.floor(Math.random() * feasibleDepts.length)];
                }
            }
        }

        let currentCost = this.calculateCost(state).totalCost;
        let bestState = this.cloneState(state);
        let bestCost = currentCost;

        let temp = 100.0;
        const coolingRate = 0.9995;
        const minTemp = 0.01;
        const maxIterations = 25000;

        for (let iter = 0; iter < maxIterations && temp > minTemp; iter++) {
            if (bestCost === 0) break;

            const r = Math.floor(Math.random() * numResources);
            const day = Math.floor(Math.random() * numDays);
            const oldDept = state[r][day];

            let newDept = -1;
            if (Math.random() < 0.8) {
                const feasibleDepts = [];
                for (let d = 0; d < numDepts; d++) {
                    if (this.feasibility[r][d]) feasibleDepts.push(d);
                }
                if (feasibleDepts.length > 0) {
                    newDept = feasibleDepts[Math.floor(Math.random() * feasibleDepts.length)];
                }
            } else {
                newDept = Math.floor(Math.random() * (numDepts + 1)) - 1;
            }

            if (newDept === oldDept) continue;

            state[r][day] = newDept;
            const newCost = this.calculateCost(state).totalCost;

            const delta = newCost - currentCost;
            if (delta <= 0 || Math.random() < Math.exp(-delta / temp)) {
                currentCost = newCost;
                if (currentCost < bestCost) {
                    bestCost = currentCost;
                    bestState = this.cloneState(state);
                }
            } else {
                state[r][day] = oldDept;
            }

            temp *= coolingRate;
        }

        const finalEvaluation = this.calculateCost(bestState);
        
        const readableAssignments = bestState.map((row, rIdx) => {
            return row.map(deptIdx => {
                return deptIdx === -1 ? "Off" : this.departments[deptIdx].name;
            });
        });

        return {
            assignments: readableAssignments,
            cost: bestCost,
            violations: finalEvaluation.violations
        };
    }

    cloneState(state) {
        return state.map(row => [...row]);
    }

    calculateCost(state) {
        let totalCost = 0;
        const violations = [];

        const numResources = this.resources.length;
        const numDepts = this.departments.length;
        const numDays = this.numDays;

        const resourceHours = Array(numResources).fill(0);
        const resourceDeptDays = Array(numResources).fill(null).map(() => Array(numDepts).fill(0));
        const deptHours = Array(numDepts).fill(0);

        for (let r = 0; r < numResources; r++) {
            const res = this.resources[r];
            const resDailyHours = res.dailyHours || this.defaultDailyHours;

            for (let day = 0; day < numDays; day++) {
                const deptIdx = state[r][day];
                if (deptIdx === -1) continue;

                const dateStr = this.dates[day];

                if (this.absentSets[r].has(dateStr)) {
                    totalCost += 10000;
                    violations.push({
                        type: "Absence Violation",
                        resource: res.name,
                        detail: `Scheduled on absent day ${dateStr}`,
                        severity: "critical"
                    });
                }

                if (!this.feasibility[r][deptIdx]) {
                    totalCost += 5000;
                    violations.push({
                        type: "Mapping Violation",
                        resource: res.name,
                        detail: `Assigned to infeasible department ${this.departments[deptIdx].name} on ${dateStr}`,
                        severity: "critical"
                    });
                }

                resourceHours[r] += resDailyHours;
                resourceDeptDays[r][deptIdx] += 1;
                deptHours[deptIdx] += resDailyHours;
            }
        }

        for (let r = 0; r < numResources; r++) {
            const res = this.resources[r];
            const hours = resourceHours[r];
            
            if (res.minHours !== undefined && res.minHours !== "" && hours < Number(res.minHours)) {
                const diff = Number(res.minHours) - hours;
                totalCost += diff * 100;
                violations.push({
                    type: "Resource Hours Deficit",
                    resource: res.name,
                    detail: `Total hours scheduled (${hours} hrs) is less than min requirement (${res.minHours} hrs) by ${diff} hrs.`,
                    severity: "high"
                });
            }

            if (res.maxHours !== undefined && res.maxHours !== "" && hours > Number(res.maxHours)) {
                const diff = hours - Number(res.maxHours);
                totalCost += diff * 100;
                violations.push({
                    type: "Resource Hours Excess",
                    resource: res.name,
                    detail: `Total hours scheduled (${hours} hrs) exceeds max allowed (${res.maxHours} hrs) by ${diff} hrs.`,
                    severity: "high"
                });
            }
        }

        for (let d = 0; d < numDepts; d++) {
            const dept = this.departments[d];
            const hours = deptHours[d];

            if (dept.minHours !== undefined && dept.minHours !== "" && hours < Number(dept.minHours)) {
                const diff = Number(dept.minHours) - hours;
                totalCost += diff * 150;
                violations.push({
                    type: "Department Hours Deficit",
                    department: dept.name,
                    detail: `Total scheduled hours (${hours} hrs) is less than department minimum (${dept.minHours} hrs) by ${diff} hrs.`,
                    severity: "high"
                });
            }

            if (dept.maxHours !== undefined && dept.maxHours !== "" && hours > Number(dept.maxHours)) {
                const diff = hours - Number(dept.maxHours);
                totalCost += diff * 100;
                violations.push({
                    type: "Department Hours Excess",
                    department: dept.name,
                    detail: `Total scheduled hours (${hours} hrs) exceeds department maximum (${dept.maxHours} hrs) by ${diff} hrs.`,
                    severity: "medium"
                });
            }
        }

        for (let r = 0; r < numResources; r++) {
            const res = this.resources[r];
            for (let d = 0; d < numDepts; d++) {
                if (!this.feasibility[r][d]) continue;

                const days = resourceDeptDays[r][d];
                const minVal = this.minDays[r][d];
                const maxVal = this.maxDays[r][d];

                if (days < minVal) {
                    const diff = minVal - days;
                    totalCost += diff * 300;
                    violations.push({
                        type: "Min Days Mapping Violation",
                        resource: res.name,
                        department: this.departments[d].name,
                        detail: `Assigned for ${days} days in ${this.departments[d].name}, which is less than min (${minVal} days).`,
                        severity: "medium"
                    });
                }

                if (days > maxVal) {
                    const diff = days - maxVal;
                    totalCost += diff * 300;
                    violations.push({
                        type: "Max Days Mapping Violation",
                        resource: res.name,
                        department: this.departments[d].name,
                        detail: `Assigned for ${days} days in ${this.departments[d].name}, which exceeds max (${maxVal} days).`,
                        severity: "medium"
                    });
                }
            }
        }

        return {
            totalCost,
            violations
        };
    }
}


// =========================================================================
// PART 2: EXCEL HANDLER (Template Generation & Data Validation)
// =========================================================================

class ExcelHandler {
    constructor() {}

    static downloadTemplate() {
        if (typeof XLSX === 'undefined') {
            alert("SheetJS library is not loaded. Cannot export template.");
            return;
        }

        const wb = XLSX.utils.book_new();

        const settingsData = [
            ["Setting Name", "Setting Value", "Description"],
            ["Start Date", "2026-08-01", "Start of plan period (YYYY-MM-DD)"],
            ["End Date", "2026-08-07", "End of plan period (YYYY-MM-DD)"],
            ["Default Daily Hours", 8, "Default work hours per shift if not specified per resource"]
        ];
        const wsSettings = XLSX.utils.aoa_to_sheet(settingsData);
        XLSX.utils.book_append_sheet(wb, wsSettings, "Settings");

        const resourcesData = [
            ["Resource Name", "Min Hours", "Max Hours", "Daily Hours", "Absent Dates"],
            ["Dr. John Doe", 20, 48, 8, "2026-08-01, 2026-08-02"],
            ["Dr. Jane Smith", 24, 40, 8, "2026-08-02, 2026-08-03"]
        ];
        const wsResources = XLSX.utils.aoa_to_sheet(resourcesData);
        XLSX.utils.book_append_sheet(wb, wsResources, "Resources");

        const deptsData = [
            ["Department Name", "Min Hours", "Max Hours"],
            ["Cardiology", 16, 80],
            ["Neurology", 16, 80]
        ];
        const wsDepts = XLSX.utils.aoa_to_sheet(deptsData);
        XLSX.utils.book_append_sheet(wb, wsDepts, "Departments");

        const mappingsData = [
            ["Resource Name", "Department Name", "Feasible", "Min Days", "Max Days"],
            ["Dr. John Doe", "Cardiology", "Yes", 1, 3],
            ["Dr. John Doe", "Neurology", "Yes", 0, 2],
            ["Dr. Jane Smith", "Cardiology", "Yes", 0, 3],
            ["Dr. Jane Smith", "Neurology", "Yes", 2, 4]
        ];
        const wsMappings = XLSX.utils.aoa_to_sheet(mappingsData);
        XLSX.utils.book_append_sheet(wb, wsMappings, "Mappings");

        XLSX.writeFile(wb, "timetable_scheduler_template.xlsx");
    }

    static parseAndValidate(arrayBuffer) {
        if (typeof XLSX === 'undefined') {
            return { success: false, errors: ["SheetJS library is not loaded. Cannot parse excel file."] };
        }

        const errors = [];
        const data = {
            startDate: "",
            endDate: "",
            defaultDailyHours: 8,
            resources: [],
            departments: [],
            mappings: []
        };

        try {
            const wb = XLSX.read(arrayBuffer, { type: 'array' });

            const requiredSheets = ["Settings", "Resources", "Departments", "Mappings"];
            for (const sheet of requiredSheets) {
                if (!wb.SheetNames.includes(sheet)) {
                    errors.push(`Missing required Sheet: "${sheet}"`);
                }
            }

            if (errors.length > 0) {
                return { success: false, errors };
            }

            const settingsSheet = wb.Sheets["Settings"];
            const settingsRows = XLSX.utils.sheet_to_json(settingsSheet, { header: 1 });
            
            if (!settingsRows[0] || settingsRows[0][0] !== "Setting Name" || settingsRows[0][1] !== "Setting Value") {
                errors.push("Sheet 'Settings': Header must start with 'Setting Name' and 'Setting Value' in columns A and B");
            } else {
                const settings = {};
                for (let i = 1; i < settingsRows.length; i++) {
                    const row = settingsRows[i];
                    if (!row[0]) continue;
                    settings[row[0].toString().trim()] = row[1];
                }

                const startDateStr = settings["Start Date"];
                if (!startDateStr) {
                    errors.push("Sheet 'Settings': 'Start Date' setting is missing.");
                } else {
                    const dateObj = new Date(startDateStr);
                    if (isNaN(dateObj.getTime())) {
                        errors.push(`Sheet 'Settings': 'Start Date' value "${startDateStr}" is not a valid date format. Use YYYY-MM-DD.`);
                    } else {
                        data.startDate = startDateStr.toString().trim();
                    }
                }

                const endDateStr = settings["End Date"];
                if (!endDateStr) {
                    errors.push("Sheet 'Settings': 'End Date' setting is missing.");
                } else {
                    const dateObj = new Date(endDateStr);
                    if (isNaN(dateObj.getTime())) {
                        errors.push(`Sheet 'Settings': 'End Date' value "${endDateStr}" is not a valid date format. Use YYYY-MM-DD.`);
                    } else {
                        data.endDate = endDateStr.toString().trim();
                    }
                }

                if (data.startDate && data.endDate && new Date(data.startDate) > new Date(data.endDate)) {
                    errors.push(`Sheet 'Settings': Start Date (${data.startDate}) cannot be after End Date (${data.endDate})`);
                }

                if (settings["Default Daily Hours"] !== undefined) {
                    const hoursVal = Number(settings["Default Daily Hours"]);
                    if (isNaN(hoursVal) || hoursVal <= 0 || hoursVal > 24) {
                        errors.push(`Sheet 'Settings': 'Default Daily Hours' must be a number between 1 and 24.`);
                    } else {
                        data.defaultDailyHours = hoursVal;
                    }
                }
            }

            const resourcesSheet = wb.Sheets["Resources"];
            const resourcesRows = XLSX.utils.sheet_to_json(resourcesSheet, { header: 1 });
            const expectedResourceHeaders = ["Resource Name", "Min Hours", "Max Hours", "Daily Hours", "Absent Dates"];
            
            if (!resourcesRows[0]) {
                errors.push("Sheet 'Resources' is empty.");
            } else {
                const headers = resourcesRows[0].map(h => h ? h.toString().trim() : "");
                expectedResourceHeaders.forEach(eh => {
                    if (!headers.includes(eh)) {
                        errors.push(`Sheet 'Resources': Missing column header "${eh}"`);
                    }
                });

                if (errors.length === 0) {
                    const nameColIdx = headers.indexOf("Resource Name");
                    const minColIdx = headers.indexOf("Min Hours");
                    const maxColIdx = headers.indexOf("Max Hours");
                    const dailyColIdx = headers.indexOf("Daily Hours");
                    const absentColIdx = headers.indexOf("Absent Dates");

                    for (let i = 1; i < resourcesRows.length; i++) {
                        const row = resourcesRows[i];
                        if (row.length === 0 || !row[nameColIdx]) continue;

                        const name = row[nameColIdx].toString().trim();
                        const minH = row[minColIdx];
                        const maxH = row[maxColIdx];
                        const dailyH = row[dailyColIdx];
                        const absentVal = row[absentColIdx];

                        if (minH !== undefined && minH !== "" && isNaN(Number(minH))) {
                            errors.push(`Sheet 'Resources', Row ${i + 1} (${name}): 'Min Hours' must be a valid number (found "${minH}")`);
                        }
                        if (maxH !== undefined && maxH !== "" && isNaN(Number(maxH))) {
                            errors.push(`Sheet 'Resources', Row ${i + 1} (${name}): 'Max Hours' must be a valid number (found "${maxH}")`);
                        }
                        if (dailyH !== undefined && dailyH !== "" && (isNaN(Number(dailyH)) || Number(dailyH) <= 0 || Number(dailyH) > 24)) {
                            errors.push(`Sheet 'Resources', Row ${i + 1} (${name}): 'Daily Hours' must be a number between 1 and 24`);
                        }

                        let absentDates = [];
                        if (absentVal) {
                            absentDates = absentVal.toString().split(',')
                                .map(d => d.trim())
                                .filter(d => {
                                    if (!d) return false;
                                    const parsed = new Date(d);
                                    if (isNaN(parsed.getTime())) {
                                        errors.push(`Sheet 'Resources', Row ${i + 1} (${name}): '${d}' is not a valid date format (Absent Dates)`);
                                        return false;
                                    }
                                    return true;
                                });
                        }

                        data.resources.push({
                            name,
                            minHours: minH !== undefined && minH !== "" ? Number(minH) : 0,
                            maxHours: maxH !== undefined && maxH !== "" ? Number(maxH) : 999,
                            dailyHours: dailyH !== undefined && dailyH !== "" ? Number(dailyH) : data.defaultDailyHours,
                            absentDates
                        });
                    }
                }
            }

            const deptsSheet = wb.Sheets["Departments"];
            const deptsRows = XLSX.utils.sheet_to_json(deptsSheet, { header: 1 });
            const expectedDeptHeaders = ["Department Name", "Min Hours", "Max Hours"];

            if (!deptsRows[0]) {
                errors.push("Sheet 'Departments' is empty.");
            } else {
                const headers = deptsRows[0].map(h => h ? h.toString().trim() : "");
                expectedDeptHeaders.forEach(eh => {
                    if (!headers.includes(eh)) {
                        errors.push(`Sheet 'Departments': Missing column header "${eh}"`);
                    }
                });

                if (errors.length === 0) {
                    const nameColIdx = headers.indexOf("Department Name");
                    const minColIdx = headers.indexOf("Min Hours");
                    const maxColIdx = headers.indexOf("Max Hours");

                    for (let i = 1; i < deptsRows.length; i++) {
                        const row = deptsRows[i];
                        if (row.length === 0 || !row[nameColIdx]) continue;

                        const name = row[nameColIdx].toString().trim();
                        const minH = row[minColIdx];
                        const maxH = row[maxColIdx];

                        if (minH !== undefined && minH !== "" && isNaN(Number(minH))) {
                            errors.push(`Sheet 'Departments', Row ${i + 1} (${name}): 'Min Hours' must be a valid number (found "${minH}")`);
                        }
                        if (maxH !== undefined && maxH !== "" && isNaN(Number(maxH))) {
                            errors.push(`Sheet 'Departments', Row ${i + 1} (${name}): 'Max Hours' must be a valid number (found "${maxH}")`);
                        }

                        data.departments.push({
                            name,
                            minHours: minH !== undefined && minH !== "" ? Number(minH) : 0,
                            maxHours: maxH !== undefined && maxH !== "" ? Number(maxH) : 9999
                        });
                    }
                }
            }

            const mappingsSheet = wb.Sheets["Mappings"];
            const mappingsRows = XLSX.utils.sheet_to_json(mappingsSheet, { header: 1 });
            const expectedMapHeaders = ["Resource Name", "Department Name", "Feasible", "Min Days", "Max Days"];

            if (!mappingsRows[0]) {
                errors.push("Sheet 'Mappings' is empty.");
            } else {
                const headers = mappingsRows[0].map(h => h ? h.toString().trim() : "");
                expectedMapHeaders.forEach(eh => {
                    if (!headers.includes(eh)) {
                        errors.push(`Sheet 'Mappings': Missing column header "${eh}"`);
                    }
                });

                if (errors.length === 0) {
                    const resColIdx = headers.indexOf("Resource Name");
                    const deptColIdx = headers.indexOf("Department Name");
                    const feasColIdx = headers.indexOf("Feasible");
                    const minColIdx = headers.indexOf("Min Days");
                    const maxColIdx = headers.indexOf("Max Days");

                    const validResourceNames = new Set(data.resources.map(r => r.name));
                    const validDeptNames = new Set(data.departments.map(d => d.name));

                    for (let i = 1; i < mappingsRows.length; i++) {
                        const row = mappingsRows[i];
                        if (row.length === 0 || !row[resColIdx]) continue;

                        const rName = row[resColIdx].toString().trim();
                        const dName = row[deptColIdx] ? row[deptColIdx].toString().trim() : "";
                        const feasibleStr = row[feasColIdx] ? row[feasColIdx].toString().trim() : "";
                        const minD = row[minColIdx];
                        const maxD = row[maxColIdx];

                        if (!validResourceNames.has(rName)) {
                            errors.push(`Sheet 'Mappings', Row ${i + 1}: Resource "${rName}" is not defined in the 'Resources' sheet.`);
                        }
                        if (!validDeptNames.has(dName)) {
                            errors.push(`Sheet 'Mappings', Row ${i + 1}: Department "${dName}" is not defined in the 'Departments' sheet.`);
                        }

                        const feasible = (feasibleStr.toLowerCase() === 'yes' || feasibleStr.toLowerCase() === 'true' || feasibleStr === '1');

                        if (minD !== undefined && minD !== "" && isNaN(Number(minD))) {
                            errors.push(`Sheet 'Mappings', Row ${i + 1} (${rName} - ${dName}): 'Min Days' must be a valid number (found "${minD}")`);
                        }
                        if (maxD !== undefined && maxD !== "" && isNaN(Number(maxD))) {
                            errors.push(`Sheet 'Mappings', Row ${i + 1} (${rName} - ${dName}): 'Max Days' must be a valid number (found "${maxD}")`);
                        }

                        data.mappings.push({
                            resourceName: rName,
                            departmentName: dName,
                            feasible,
                            minDays: minD !== undefined && minD !== "" ? Number(minD) : 0,
                            maxDays: maxD !== undefined && maxD !== "" ? Number(maxD) : 999
                        });
                    }
                }
            }

        } catch (err) {
            errors.push(`General Excel parsing exception: ${err.message}`);
        }

        return {
            success: errors.length === 0,
            data: errors.length === 0 ? data : null,
            errors
        };
    }
}

// =========================================================================
// PART 3: APPLICATION STATE & EVENT CONTROLLER
// =========================================================================

const state = {
    config: null,
    solverResults: null,
    activeScheduleIdx: 0
};

const elements = {
    btnDownloadTemplate: document.getElementById('btnDownloadTemplate'),
    btnDownloadTemplateEmpty: document.getElementById('btnDownloadTemplateEmpty'),
    excelUpload: document.getElementById('excelUpload'),
    btnUploadTrigger: document.getElementById('btnUploadTrigger'),
    btnUploadTemplateEmpty: document.getElementById('btnUploadTemplateEmpty'),
    startDate: document.getElementById('startDate'),
    endDate: document.getElementById('endDate'),
    defaultDailyHours: document.getElementById('defaultDailyHours'),
    btnHowToUse: document.getElementById('btnHowToUse'),
    btnCloseHowToUse: document.getElementById('btnCloseHowToUse'),
    btnConfirmHowToUse: document.getElementById('btnConfirmHowToUse'),
    howToUseModal: document.getElementById('howToUseModal'),
    btnGenerateSchedule: document.getElementById('btnGenerateSchedule'),
    validationStatusPanel: document.getElementById('validationStatusPanel'),
    configOverviewStats: document.getElementById('configOverviewStats'),
    statResourcesCount: document.getElementById('statResourcesCount'),
    statDeptsCount: document.getElementById('statDeptsCount'),
    statHorizonCount: document.getElementById('statHorizonCount'),
    emptyStateContainer: document.getElementById('emptyStateContainer'),
    solverLoader: document.getElementById('solverLoader'),
    resultsDashboard: document.getElementById('resultsDashboard'),
    solverStatusAlert: document.getElementById('solverStatusAlert'),
    alternativesSelectorCard: document.getElementById('alternativesSelectorCard'),
    alternativesBtnGroup: document.getElementById('alternativesBtnGroup'),
    scheduleTableResult: document.getElementById('scheduleTableResult'),
    resourceSummaryTable: document.getElementById('resourceSummaryTable').querySelector('tbody'),
    deptSummaryTable: document.getElementById('deptSummaryTable').querySelector('tbody'),
    btnExportResult: document.getElementById('btnExportResult')
};

function init() {
    const toggleHowToUse = (show) => {
        elements.howToUseModal.classList.toggle('active', show);
    };
    elements.btnHowToUse.addEventListener('click', () => toggleHowToUse(true));
    elements.btnCloseHowToUse.addEventListener('click', () => toggleHowToUse(false));
    elements.btnConfirmHowToUse.addEventListener('click', () => toggleHowToUse(false));

    const triggerTemplateDownload = () => {
        ExcelHandler.downloadTemplate();
    };
    elements.btnDownloadTemplate.addEventListener('click', triggerTemplateDownload);
    if (elements.btnDownloadTemplateEmpty) {
        elements.btnDownloadTemplateEmpty.addEventListener('click', triggerTemplateDownload);
    }

    const triggerUploadSelect = () => {
        elements.excelUpload.click();
    };
    elements.btnUploadTrigger.addEventListener('click', triggerUploadSelect);
    if (elements.btnUploadTemplateEmpty) {
        elements.btnUploadTemplateEmpty.addEventListener('click', triggerUploadSelect);
    }

    elements.excelUpload.addEventListener('change', handleExcelUpload);
    elements.startDate.addEventListener('change', handleDateSettingsChange);
    elements.endDate.addEventListener('change', handleDateSettingsChange);
    elements.defaultDailyHours.addEventListener('change', handleDateSettingsChange);
    elements.btnGenerateSchedule.addEventListener('click', generateRoster);
    elements.btnExportResult.addEventListener('click', exportGeneratedRoster);
}

function handleDateSettingsChange() {
    if (!state.config) return;
    
    state.config.startDate = elements.startDate.value;
    state.config.endDate = elements.endDate.value;
    state.config.defaultDailyHours = Number(elements.defaultDailyHours.value) || 8;
    
    updateStatsOverview();
}

function handleExcelUpload(e) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(evt) {
        const arrayBuffer = evt.target.result;
        const result = ExcelHandler.parseAndValidate(arrayBuffer);

        if (result.success) {
            state.config = result.data;
            showValidationFeedback(true, []);
            
            elements.startDate.value = state.config.startDate;
            elements.endDate.value = state.config.endDate;
            elements.defaultDailyHours.value = state.config.defaultDailyHours;

            elements.emptyStateContainer.style.display = 'none';
            elements.configOverviewStats.style.display = 'grid';
            updateStatsOverview();
            
            elements.resultsDashboard.style.display = 'none';
        } else {
            showValidationFeedback(false, result.errors);
        }
    };
    reader.readAsArrayBuffer(file);
}

function showValidationFeedback(success, errorsList) {
    elements.validationStatusPanel.innerHTML = "";
    
    const alert = document.createElement('div');
    alert.className = `alert-box ${success ? 'success' : 'error'}`;
    
    if (success) {
        alert.innerHTML = `
            <div class="alert-title">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
                Excel File Uploaded and Verified!
            </div>
            <div style="font-size: 0.875rem;">Your configuration has been successfully imported. Ready to generate the timetable.</div>
        `;
    } else {
        let errorLi = errorsList.map(err => `<li>${err}</li>`).join('');
        alert.innerHTML = `
            <div class="alert-title">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                Excel Data Verification Failed
            </div>
            <div style="font-size: 0.875rem;">Please review the errors below and correct them in your workbook:</div>
            <ul class="violation-list" style="margin-top: 0.5rem; max-height: 200px; overflow-y: auto;">
                ${errorLi}
            </ul>
        `;
    }
    
    elements.validationStatusPanel.appendChild(alert);
}

function updateStatsOverview() {
    if (!state.config) return;

    elements.statResourcesCount.textContent = state.config.resources.length;
    elements.statDeptsCount.textContent = state.config.departments.length;
    
    const start = new Date(state.config.startDate);
    const end = new Date(state.config.endDate);
    if (!isNaN(start.getTime()) && !isNaN(end.getTime()) && start <= end) {
        const diffDays = Math.ceil((end - start) / (1000 * 60 * 60 * 24)) + 1;
        elements.statHorizonCount.textContent = `${diffDays} Day${diffDays > 1 ? 's' : ''}`;
    } else {
        elements.statHorizonCount.textContent = "Invalid range";
    }
}

function generateRoster() {
    if (!state.config) {
        alert("Please upload your Excel config data first.");
        return;
    }

    elements.resultsDashboard.style.display = 'none';
    elements.solverLoader.style.display = 'flex';

    setTimeout(() => {
        try {
            const solver = new TimetableSolver(state.config);
            const results = solver.solve(3);

            elements.solverLoader.style.display = 'none';
            
            if (results.status === 'error') {
                alert(`Solver Error: ${results.message}`);
                return;
            }

            state.solverResults = results;
            state.activeScheduleIdx = 0;

            renderSolverResults();
        } catch (err) {
            elements.solverLoader.style.display = 'none';
            alert(`Exception while solving timetable: ${err.message}`);
        }
    }, 600);
}

function renderSolverResults() {
    const results = state.solverResults;
    if (!results || !results.schedules || results.schedules.length === 0) return;

    elements.resultsDashboard.style.display = 'flex';
    
    renderSolverStatusHeader(results.status);

    if (results.schedules.length > 1) {
        elements.alternativesSelectorCard.style.display = 'flex';
        elements.alternativesBtnGroup.innerHTML = '';
        
        results.schedules.forEach((sch, idx) => {
            const btn = document.createElement('button');
            btn.className = `btn ${idx === state.activeScheduleIdx ? 'btn-primary' : 'btn-secondary'}`;
            btn.textContent = `Schedule Option ${idx + 1} (${sch.violations.length} Violation${sch.violations.length === 1 ? '' : 's'})`;
            btn.style.fontSize = "0.75rem";
            btn.style.padding = "0.375rem 0.75rem";
            btn.addEventListener('click', () => {
                state.activeScheduleIdx = idx;
                renderSolverResults();
            });
            elements.alternativesBtnGroup.appendChild(btn);
        });
    } else {
        elements.alternativesSelectorCard.style.display = 'none';
    }

    const activeSchedule = results.schedules[state.activeScheduleIdx];
    const assignments = activeSchedule.assignments;

    renderScheduleGrid(assignments);
    renderStatisticsMetrics(assignments);
}

function renderSolverStatusHeader(status) {
    const activeSchedule = state.solverResults.schedules[state.activeScheduleIdx];
    const violations = activeSchedule.violations;
    
    elements.solverStatusAlert.innerHTML = '';
    const alert = document.createElement('div');

    if (violations.length === 0) {
        alert.className = "alert-box success";
        alert.innerHTML = `
            <div class="alert-title">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
                Perfect Schedule Found!
            </div>
            <div style="font-size: 0.875rem;">All constraints, work limits, mappings, and absences have been fully satisfied. No violations detected.</div>
        `;
    } else {
        alert.className = "alert-box warning";
        let listItems = violations.map(v => {
            return `<li>
                <span class="shift-badge ${v.severity === 'critical' ? 'absent' : ''}" style="text-decoration: none; padding: 0.125rem 0.375rem; font-size: 0.7rem; margin-right: 0.5rem;">${v.type}</span>
                <strong>${v.resource || v.department || ''}</strong>: ${v.detail}
            </li>`;
        }).join('');
        
        alert.innerHTML = `
            <div class="alert-title" style="color: var(--error);">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                Feasible Schedule with Relaxed Constraints
            </div>
            <div style="font-size: 0.875rem; margin-bottom: 0.5rem;">A clean conflict-free schedule was not possible. The scheduling engine resolved this with the minimal violations possible:</div>
            <ul class="violation-list" style="max-height: 180px; overflow-y: auto; gap: 0.5rem;">
                ${listItems}
            </ul>
        `;
    }

    elements.solverStatusAlert.appendChild(alert);
}

function renderScheduleGrid(assignments) {
    const table = elements.scheduleTableResult;
    const thead = table.querySelector('thead');
    const tbody = table.querySelector('tbody');

    thead.innerHTML = '';
    tbody.innerHTML = '';

    const solver = new TimetableSolver(state.config);
    const dates = solver.dates;

    const headerRow = document.createElement('tr');
    const resHeader = document.createElement('th');
    resHeader.textContent = "Resource Name";
    headerRow.appendChild(resHeader);

    dates.forEach(d => {
        const th = document.createElement('th');
        const parts = d.split('-');
        th.textContent = `${parts[1]}/${parts[2]}`;
        
        const dateObj = new Date(d);
        if (dateObj.getDay() === 0 || dateObj.getDay() === 6) {
            th.style.color = 'var(--text-muted)';
            th.style.backgroundColor = 'var(--primary-light)';
        }
        headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);

    state.config.resources.forEach((r, rIdx) => {
        const tr = document.createElement('tr');
        const tdName = document.createElement('td');
        tdName.innerHTML = `<strong>${r.name}</strong>`;
        tr.appendChild(tdName);

        dates.forEach((d, dayIdx) => {
            const td = document.createElement('td');
            const assignment = assignments[rIdx][dayIdx];
            
            const badge = document.createElement('span');
            badge.className = 'shift-badge';

            const absentSet = new Set(r.absentDates || []);
            if (absentSet.has(d)) {
                badge.className += ' absent';
                badge.textContent = assignment !== 'Off' ? `${assignment} (Abs)` : 'Absent';
            } else if (assignment === 'Off') {
                badge.className += ' off';
                badge.textContent = 'Off';
            } else {
                badge.textContent = assignment;
            }

            td.appendChild(badge);
            tr.appendChild(td);
        });

        tbody.appendChild(tr);
    });
}

function renderStatisticsMetrics(assignments) {
    const solver = new TimetableSolver(state.config);
    const dates = solver.dates;
    
    const resSummary = state.config.resources.map((r, rIdx) => {
        let totalHours = 0;
        dates.forEach((_, dayIdx) => {
            if (assignments[rIdx][dayIdx] !== 'Off') {
                totalHours += r.dailyHours || state.config.defaultDailyHours || 8;
            }
        });
        return { name: r.name, min: r.minHours || 0, max: r.maxHours || 999, actual: totalHours };
    });

    const deptSummary = state.config.departments.map(d => {
        let totalHours = 0;
        state.config.resources.forEach((r, rIdx) => {
            dates.forEach((_, dayIdx) => {
                if (assignments[rIdx][dayIdx] === d.name) {
                    totalHours += r.dailyHours || state.config.defaultDailyHours || 8;
                }
            });
        });
        return { name: d.name, min: d.minHours || 0, max: d.maxHours || 9999, actual: totalHours };
    });

    elements.resourceSummaryTable.innerHTML = '';
    resSummary.forEach(r => {
        const tr = document.createElement('tr');
        
        let statusBadge = '<span class="shift-badge" style="background-color: var(--success-light); color: var(--success);">Satisfied</span>';
        if (r.actual < r.min) {
            statusBadge = '<span class="shift-badge absent">Deficit</span>';
        } else if (r.actual > r.max) {
            statusBadge = '<span class="shift-badge absent">Overloaded</span>';
        }

        tr.innerHTML = `
            <td><strong>${r.name}</strong></td>
            <td>${r.min} - ${r.max} hrs</td>
            <td>${r.actual} hrs</td>
            <td>${statusBadge}</td>
        `;
        elements.resourceSummaryTable.appendChild(tr);
    });

    elements.deptSummaryTable.innerHTML = '';
    deptSummary.forEach(d => {
        const tr = document.createElement('tr');
        
        let statusBadge = '<span class="shift-badge" style="background-color: var(--success-light); color: var(--success);">Covered</span>';
        if (d.actual < d.min) {
            statusBadge = '<span class="shift-badge absent">Shortage</span>';
        } else if (d.actual > d.max) {
            statusBadge = '<span class="shift-badge absent">Excess</span>';
        }

        tr.innerHTML = `
            <td><strong>${d.name}</strong></td>
            <td>${d.min} - ${d.max} hrs</td>
            <td>${d.actual} hrs</td>
            <td>${statusBadge}</td>
        `;
        elements.deptSummaryTable.appendChild(tr);
    });
}

function exportGeneratedRoster() {
    if (typeof XLSX === 'undefined' || !state.solverResults) return;

    const solver = new TimetableSolver(state.config);
    const dates = solver.dates;
    const activeSchedule = state.solverResults.schedules[state.activeScheduleIdx];
    const assignments = activeSchedule.assignments;

    const xlHeaders = ["Resource Name", ...dates];
    const xlRows = [xlHeaders];

    state.config.resources.forEach((r, rIdx) => {
        const row = [r.name];
        dates.forEach((_, dayIdx) => {
            row.push(assignments[rIdx][dayIdx]);
        });
        xlRows.push(row);
    });

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(xlRows);
    XLSX.utils.book_append_sheet(wb, ws, "Schedule Matrix");

    const violationsRows = [["Violation Type", "Target Entity", "Detail", "Severity"]];
    activeSchedule.violations.forEach(v => {
        violationsRows.push([v.type, v.resource || v.department || 'General', v.detail, v.severity]);
    });
    const wsV = XLSX.utils.aoa_to_sheet(violationsRows);
    XLSX.utils.book_append_sheet(wb, wsV, "Violations and Warnings");

    XLSX.writeFile(wb, "optimal_generated_schedule.xlsx");
}

document.addEventListener('DOMContentLoaded', init);
