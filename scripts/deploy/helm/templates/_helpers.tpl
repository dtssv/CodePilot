{{- define "codepilot.fullname" -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "codepilot.labels" -}}
app.kubernetes.io/name: codepilot
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}

{{- define "codepilot.selectorLabels" -}}
app.kubernetes.io/name: codepilot
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}